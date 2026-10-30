"""Parse an uploaded account table from stdin. JSON stdout is private IPC only."""
import csv
import io
import json
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location('account_rows', pathlib.Path(__file__).with_name('read-social-accounts.py'))
account_rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(account_rows)
slug, profile_handle = account_rows.slug, account_rows.profile_handle


def normal(value):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', value.lower().replace('đ', 'd')).encode('ascii', 'ignore').decode())


HEADERS = {
    'platform': ['socialnetwork', 'social', 'platform', 'nentang', 'tensocial'],
    'loginUsername': ['user', 'username', 'email', 'taikhoan', 'loginusername', 'emailaccount'],
    'password': ['pass', 'password', 'matkhau', 'passwordauth'],
    'provider': ['phuongthuclogin', 'phuongthucdangnhap', 'loginmethod', 'provider'],
    'totpSecret': ['2fa', 'totp', 'totpsecret'],
    'profileUrl': ['urlprofile', 'profileurl', 'profile', 'linkprofile'],
    'loginUrl': ['urldangnhap', 'loginurl'],
    'targetUrl': ['urldangbai', 'posturl', 'targeturl', 'publicationurl', 'spaceurl'],
    'tags': ['tags', 'tag'], 'category': ['category', 'chuyenmuc'],
}


def xlsx(data):
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2000 or sum(e.file_size for e in entries) > 20 * 1024 * 1024:
            raise ValueError('Workbook too large')
        def xml(name):
            raw = archive.read(name)
            if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
                raise ValueError('XML declarations not allowed')
            return ET.fromstring(raw)
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(n.itertext()) for n in xml('xl/sharedStrings.xml').findall('m:si', ns)]
        rows = []
        for row in xml('xl/worksheets/sheet1.xml').findall('m:sheetData/m:row', ns):
            values = [''] * 32
            for cell in row.findall('m:c', ns):
                col = re.sub('[0-9]', '', cell.get('r', ''))
                index = 0
                for char in col:
                    index = index * 26 + ord(char) - 64
                if not 1 <= index <= 32:
                    continue
                value = cell.find('m:v', ns)
                value = value.text or '' if value is not None else ''
                if cell.get('t') == 's':
                    value = strings[int(value)] if value else ''
                elif cell.get('t') == 'inlineStr':
                    inline = cell.find('m:is', ns)
                    value = ''.join(inline.itertext()) if inline is not None else ''
                # Formula cells are never evaluated or used as credentials.
                if cell.find('m:f', ns) is not None:
                    value = ''
                values[index - 1] = value
            rows.append(values)
            if len(rows) > 501:
                raise ValueError('At most 500 accounts')
        return rows


def parse(data, kind):
    if len(data) > 2 * 1024 * 1024:
        raise ValueError('File too large')
    if kind == 'xlsx':
        table = xlsx(data)
    else:
        raw = data.decode('utf-8-sig')
        delimiter = '\t' if '\t' in raw.splitlines()[0] else ','
        table = list(csv.reader(io.StringIO(raw), delimiter=delimiter))
    table = [row for row in table if any(c.strip() for c in row)]
    if not table or len(table) > 501:
        raise ValueError('Empty or too many rows')
    columns = {key: next((i for i, name in enumerate(table[0]) if normal(name) in names), None) for key, names in HEADERS.items()}
    if columns['profileUrl'] is None:
        columns['profileUrl'] = next((i for i, name in enumerate(table[0]) if normal(name).startswith('urlsocial')), None)
    if columns['platform'] is None or columns['loginUsername'] is None:
        raise ValueError('Require Social Network and User/Email columns')
    result, previous_platform = [], ''
    for number, cells in enumerate(table[1:], 2):
        values = {key: cells[index] if index is not None and index < len(cells) else '' for key, index in columns.items()}
        social = values['platform'].strip() or previous_platform
        previous_platform = social
        if not values['loginUsername'].strip():
            continue
        if any(len(v) > 4096 for v in values.values()):
            raise ValueError('Cell too long')
        values.update(source=f'upload:{number}', label=social, platform=slug(social),
                      loginUsername=values['loginUsername'].strip(),
                      provider='google' if 'google' in values['provider'].lower() else 'password')
        values['expectedUsername'] = profile_handle(values)
        result.append(values)
    if not result:
        raise ValueError('No accounts')
    return result


if __name__ == '__main__':
    try:
        sys.stdout.write(json.dumps(parse(sys.stdin.buffer.read(2 * 1024 * 1024 + 1), sys.argv[1]), ensure_ascii=True))
    except Exception:
        sys.stderr.write('Invalid account file; no credential data logged')
        sys.exit(1)
