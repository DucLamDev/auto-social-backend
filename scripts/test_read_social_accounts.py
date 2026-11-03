import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('accounts', pathlib.Path(__file__).with_name('read-social-accounts.py'))
accounts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounts)


class AccountInputTests(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'input.txt'
            path.write_text(text, encoding='utf-8')
            return accounts.read_paste(path)

    def test_literal_password_quote_does_not_consume_other_accounts(self):
        rows = self.parse('59\tX (Twitter)\thttps://x.com/\tEmail\talice\t"a-secret\t\thttps://x.com/alice\n60\tMedium\thttps://medium.com/\tGmail / Google Auth\tbob\tother-secret\t\thttps://medium.com/@bob')
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['password'], '"a-secret')
        self.assertEqual(rows[1]['provider'], 'google')

    def test_wrapped_totp_and_empty_merged_url_keep_the_correct_row(self):
        rows = self.parse('1\tMedium\thttps://medium.com/\tEmail\talice\t secret with spaces \tABCD EFGH\n\thttps://medium.com/@alice\n2\tMedium\t\tEmail\tbob\tsecond\t\thttps://medium.com/@bob')
        self.assertEqual(rows[0]['password'], ' secret with spaces ')
        self.assertEqual(rows[0]['totpSecret'], 'ABCDEFGH')
        self.assertEqual(rows[1]['loginUrl'], 'https://medium.com/')
        self.assertEqual(rows[1]['loginUsername'], 'bob')

    def test_malformed_data_is_rejected_without_echoing_values(self):
        with self.assertRaisesRegex(ValueError, 'Unrecognized pasted table layout') as error:
            self.parse('1\tsecret-fixture\tmissing-columns')
        self.assertNotIn('secret-fixture', str(error.exception))

    def test_password_preference_is_scoped_to_platform_and_login(self):
        rows = [dict(platform=platform, loginUsername=user, source=source, password=password)
                for platform, user, source, password in [
                    ('mastodon', 'alice', 'paste:1', 'old'),
                    ('mastodon', 'ALICE', 'xlsx:2', 'chosen'),
                    ('mastodon', 'bob', 'paste:3', 'keep-bob'),
                    ('medium', 'alice', 'paste:4', 'keep-medium'),
                    ('medium', 'alice', 'xlsx:5', 'other-medium')]]
        accounts.prefer_xlsx_passwords(rows, ['mastodon'])
        self.assertEqual([r['password'] for r in rows], ['chosen', 'chosen', 'keep-bob', 'keep-medium', 'other-medium'])

    def test_brand_selection_uses_public_identity_not_password_or_query(self):
        rows = [dict(loginUsername='alice@example.test', profileUrl=url, password='vpsttt-secret') for url in [
            'https://forum.test/u/VPSTTT/summary', 'https://tinhte.vn/members/vpsttt.123/',
            'https://bsky.app/profile/vpsttt.bsky.social', 'https://vpsttt.blogspot.com/',
            'https://site.test/@vpsttt_group', 'https://dev.to/vpstttt',
            'https://site.test/users/123/vpsttt.html', 'https://site.test/other?ref=vpsttt',
            'https://www.mongodb.com/community/forums/u/vpsttt/preferences/account']]
        selected = accounts.select_brand(rows, 'vpsttt')
        self.assertEqual(len(selected), 8)
        self.assertEqual(selected[1]['expectedUsername'], 'vpsttt')
        self.assertEqual(selected[-1]['expectedUsername'], 'vpsttt')

    def test_site_screens_are_not_taken_as_the_account_name(self):
        handle = lambda url: accounts.profile_handle({'profileUrl': url})
        for url in ['https://voz.vn/register/complete', 'https://dev.to/onboarding?referrer=x', 'https://medium.com/get-started/topics',
                    'https://www.tumblr.com/getting-to-know-tumblr/topics?redirect_to=%2F', 'https://discord.com/channels/@me',
                    'https://wordpress.com/setup/onboarding/domains?user_email=x', 'https://www.blogger.com/about/', 'https://flipboard.com/profile',
                    'https://gravatar.com/profile/about', 'https://aws.amazon.com/vi/profile', 'https://gumroad.com/dashboard',
                    'https://huggingface.co/email_confirmation', 'https://www.eventbrite.com/u/3012744608965/', 'https://substack.com/']:
            self.assertEqual(handle(url), '', url)
        self.assertEqual(handle('https://www.tumblr.com/blog/haihai581'), 'haihai581')
        self.assertEqual(handle('https://plainenglish.io/author/gia-huy'), 'gia-huy')
        self.assertEqual(handle('https://www.warriorforum.com/members/VPSTTT.html?utm_source=internal&utm_medium=user-menu'), 'VPSTTT')
        self.assertEqual(handle('https://mewe.com/vpsttt_group/posts'), 'vpsttt_group')
        self.assertEqual(handle('https://huggingface.co/VPSTTT'), 'VPSTTT')
        self.assertEqual(handle('https://forum.linuxfoundation.org/profile/211511/Vpsttt'), 'Vpsttt')


if __name__ == '__main__':
    unittest.main()
