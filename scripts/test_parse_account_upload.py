import importlib.util
import io
import pathlib
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('upload', pathlib.Path(__file__).with_name('parse-account-upload.py'))
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)

HEADER = 'Nền tảng,Tên hiển thị,URL,Username / Handle,Khoá bí mật,Category ID,Tags,Đăng ngay,Chế độ hiển thị'


def workbook(rows):
    """Minimal XLSX with inline strings; a cell given as ('=', value) carries a formula."""
    def cell(ref, value):
        if isinstance(value, tuple):
            return f'<c r="{ref}"><f>HYPERLINK("x")</f><v>{value[1]}</v></c>'
        return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'
    sheet_rows = ''.join(
        f'<row r="{r}">' + ''.join(cell(f'{chr(65 + c)}{r}', v) for c, v in enumerate(row) if v != '') + '</row>'
        for r, row in enumerate(rows, 1))
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('xl/worksheets/sheet1.xml',
                         '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                         f'<sheetData>{sheet_rows}</sheetData></worksheet>')
    return data.getvalue()


class ApiUploadTests(unittest.TestCase):
    def test_csv_with_bom_quotes_vietnamese_headers_and_real_row_numbers(self):
        text = f'﻿{HEADER}\n"dev.to","Dev, chính",,alice,key-123,,,không,\n,,,,,,,,\nBluesky,,, bob.bsky.social ,abcd-efgh-ijkl-mnop,,,,\n'
        rows = upload.parse_api(text.encode('utf-8'), 'csv')
        self.assertEqual([row['source'] for row in rows], ['upload:2', 'upload:4'])
        self.assertEqual(rows[0]['name'], 'Dev, chính')
        self.assertEqual(rows[0]['publishNow'], 'không')
        self.assertEqual(rows[1]['username'], 'bob.bsky.social')
        self.assertEqual(rows[1]['secret'], 'abcd-efgh-ijkl-mnop')

    def test_tsv_and_english_headers(self):
        text = 'Platform\tName\tURL\tUsername\tSecret\tCategory ID\nDiscourse\tForum\thttps://forum.example.com\tbot\tk\t12\n'
        rows = upload.parse_api(text.encode('utf-8'), 'tsv')
        self.assertEqual(rows[0]['categoryId'], '12')
        self.assertEqual(rows[0]['url'], 'https://forum.example.com')

    def test_xlsx_ignores_formula_cells(self):
        data = workbook([
            ['Nền tảng', 'Username / Handle', 'Khoá bí mật'],
            ['dev.to', 'alice', ('=', 'computed-secret')],
            ['dev.to', 'bob', 'real-key'],
        ])
        rows = upload.parse_api(data, 'xlsx')
        self.assertEqual(rows[0]['secret'], '')
        self.assertEqual(rows[1]['secret'], 'real-key')

    def test_rejects_missing_columns_empty_and_oversized_files(self):
        with self.assertRaises(ValueError):
            upload.parse_api('Nền tảng,Username\ndev.to,alice\n'.encode('utf-8'), 'csv')
        with self.assertRaises(ValueError):
            upload.parse_api(f'{HEADER}\n'.encode('utf-8'), 'csv')
        with self.assertRaises(ValueError):
            upload.parse_api(b'x' * (2 * 1024 * 1024 + 1), 'csv')
        with self.assertRaises(ValueError):
            upload.parse_api(f'{HEADER}\ndev.to,,,alice,{"k" * 5000}\n'.encode('utf-8'), 'csv')

    def test_login_mode_is_unchanged(self):
        rows = upload.parse('Social Network,User,Pass\nMedium,alice,secret\n,,\nMedium,bob,\n'.encode('utf-8'), 'csv')
        self.assertEqual([row['source'] for row in rows], ['upload:2', 'upload:3'])


if __name__ == '__main__':
    unittest.main()
