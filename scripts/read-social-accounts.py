"""Read user-supplied account files. Default output contains counts, never secrets.

--json is only for piping directly to the private import process; don't redirect
it to a file or log. Document cells are data and never executed as instructions.
"""
import argparse
import collections
import json
import pathlib
import re
import xml.etree.ElementTree as ET
import zipfile
from urllib.parse import urlparse, unquote

ALIASES = {
    'x (twitter)': 'x', 'tiktok': 'tiktok', 'wordpress': 'wordpress',
    'dev.to': 'devto', 'slide share': 'slideshare', 'aws community': 'aws-community',
    'mastodon.social': 'mastodon', 'tinhte.vn': 'tinhte',
    'social.vivaldi.net': 'vivaldi-social', 'vivaldi social': 'vivaldi-social',
    'pixelfed.social': 'pixelfed-social', 'pixelfed': 'pixelfed-social',
    'lemmy.world': 'lemmy-world', 'lemmy': 'lemmy-world', 'discuit.org': 'discuit', 'minds.com': 'minds',
    'mewe.com': 'mewe', 'serverfault': 'server-fault', 'daily.dev': 'daily-dev',
    'linux foundation': 'linux-foundation-forum', 'linux foundation forum': 'linux-foundation-forum',
    'hub': 'hub', 'dzone': 'dzone', 'scoop.it': 'scoop-it',
    'unix & linux stack exchange': 'unix-linux-stackexchange',
}


def slug(label):
    key = label.strip().lower()
    return ALIASES.get(key, re.sub(r'[^a-z0-9]+', '-', key).strip('-'))


def unquote_cell(value, preserve=False):
    if not preserve:
        value = value.strip()
    # Pasted spreadsheet cells with line breaks are surrounded by CSV quotes.
    if '\n' in value and value.startswith('"') and value.endswith('"'):
        value = value[1:-1].replace('""', '"')
    return value


def read_paste(path):
    raw = pathlib.Path(path).read_text(encoding='utf-8-sig')
    rows, login_urls = [], {}
    # Passwords can contain a literal quote; csv.reader would swallow all
    # following rows. Numbered row boundaries disambiguate this clipboard data.
    for group in re.split(r'(?m)(?=^\d+\t)', raw):
        if not group.strip():
            continue
        cells = group.rstrip('\r\n').split('\t')
        if len(cells) != 8 or not cells[0].isdigit():
            raise ValueError('Unrecognized pasted table layout; no account imported')
        number, social, login, method, user, password, totp, profile = [unquote_cell(value, i == 5) for i, value in enumerate(cells)]
        platform = slug(social)
        if login:
            login_urls[platform] = login
        rows.append(dict(source='paste:' + number, platform=platform, label=social,
                         loginUrl=login or login_urls.get(platform, ''),
                         provider='google' if 'google' in method.lower() else 'password',
                         loginUsername=user.strip(), password=password,
                         totpSecret=re.sub(r'\s+', '', totp), profileUrl=profile.strip()))
    return rows


def read_xlsx(path):
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    result = []
    with zipfile.ZipFile(path) as archive:
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', ns)]
        root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        for row in root.findall('m:sheetData/m:row', ns)[1:]:
            values = {}
            for cell in row.findall('m:c', ns):
                value = cell.find('m:v', ns)
                value = value.text if value is not None else ''
                if cell.get('t') == 's':
                    value = strings[int(value)] if value else ''
                elif cell.get('t') == 'inlineStr':
                    inline = cell.find('m:is', ns)
                    value = ''.join(inline.itertext()) if inline is not None else ''
                values[re.sub(r'\d', '', cell.get('r'))] = value
            social = values.get('B', '').strip()
            if not social:
                continue
            result.append(dict(source='xlsx:' + row.get('r'), platform=slug(social), label=social,
                               loginUrl='', provider=None, loginUsername=values.get('C', '').strip(),
                               password=values.get('D', ''), totpSecret='', profileUrl=values.get('E', '').strip()))
    return result


def prefer_xlsx_passwords(rows, platforms):
    """Apply an explicit source choice to matching logins, never across accounts."""
    selected = set(platforms)
    passwords = collections.defaultdict(set)
    for row in rows:
        if row['platform'] in selected and row['source'].startswith('xlsx:') and row['password']:
            passwords[(row['platform'], row['loginUsername'].lower())].add(row['password'])
    for row in rows:
        choices = passwords.get((row['platform'], row['loginUsername'].lower()), set())
        if len(choices) == 1:
            row['password'] = next(iter(choices))
            row['passwordSource'] = 'xlsx'
    return rows


def read_inputs(xlsx, paste, preferred_passwords=()):
    rows = read_paste(paste) + (read_xlsx(xlsx) if xlsx else [])
    # An XLSX row omits the provider. Inherit it only from the exact same
    # platform+login in the more detailed pasted table, never from a password.
    providers = {(r['platform'], r['loginUsername'].lower()): r['provider'] for r in rows if r['provider']}
    for row in rows:
        row['provider'] = row['provider'] or providers.get((row['platform'], row['loginUsername'].lower()), 'password')
    return prefer_xlsx_passwords(rows, preferred_passwords)


def profile_handle(row):
    """Extract a public profile handle, not a login email or password."""
    try:
        url = urlparse(row.get('profileUrl', ''))
        parts = [unquote(p) for p in url.path.split('/') if p]
        if (url.hostname or '').endswith('.blogspot.com'):
            return url.hostname.split('.')[0]
        if parts and parts[0].startswith('@'):
            handle = parts[0][1:]
        elif len(parts) >= 2 and parts[0].lower() in ('u', 'profile', 'members', 'member', 'user', 'by', 'in'):
            handle = parts[1]
            if handle.isdigit() and len(parts) > 2:
                handle = parts[2]
        elif len(parts) >= 3 and parts[0] == 'users':
            handle = parts[2]
        elif 'u' in parts and len(parts) > parts.index('u') + 1:
            handle = parts[parts.index('u') + 1]
        else:
            handle = parts[0] if parts else ''
        return re.sub(r'(?:\.\d+|\.html)$', '', handle, flags=re.I)
    except ValueError:
        return ''


def select_brand(rows, brand):
    selected = []
    for row in rows:
        handle = profile_handle(row)
        if brand.casefold() in handle.casefold():
            selected.append(dict(row, expectedUsername=handle))
        elif not handle and brand.casefold() in row['loginUsername'].casefold() and '@' not in row['loginUsername']:
            selected.append(dict(row, expectedUsername=row['loginUsername']))
    return selected


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--xlsx')
    parser.add_argument('--paste', required=True)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--prefer-xlsx-passwords', default='')
    parser.add_argument('--brand')
    args = parser.parse_args()
    try:
        rows = read_inputs(args.xlsx, args.paste, args.prefer_xlsx_passwords.split(','))
        if args.brand:
            rows = select_brand(rows, args.brand)
        output = rows if args.json else {'sourceRows': len(rows), 'platforms': dict(collections.Counter(r['platform'] for r in rows)),
                                        'googleRows': sum(r['provider'] == 'google' for r in rows),
                                        'missingUser': sum(not r['loginUsername'] for r in rows)}
        print(json.dumps(output, ensure_ascii=True))
    except Exception:
        raise SystemExit('Could not parse account files; no credential data printed')
