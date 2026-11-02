import { PrismaService } from '../database/prisma.service';
import { BRAND_PROFILE_SETTING_KEY, brandProfileBlock, BrandProfileService, parseBrandProfile } from './brand-profile.service';

const profile = {
  brandName: 'VPSTTT',
  oneLiner: 'Nhà cung cấp VPS tại Việt Nam',
  facts: ['VPS NVMe, đặt tại Hà Nội và TP.HCM'],
  links: [{ label: 'Bảng giá', url: 'https://vpsttt.com/bang-gia' }],
  disclosure: 'Mình làm ở VPSTTT.',
  avoid: ['Không hứa uptime 100%'],
  defaultLanguage: 'vi',
  platformLanguages: { quora: 'vi' },
};

function service(findUnique: jest.Mock) {
  return new BrandProfileService({ systemSetting: { findUnique } } as unknown as PrismaService);
}

describe('BrandProfileService', () => {
  it('loads a valid profile from the system setting', async () => {
    const findUnique = jest.fn().mockResolvedValue({ key: BRAND_PROFILE_SETTING_KEY, value: profile, secret: false });
    await expect(service(findUnique).load()).resolves.toEqual(profile);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: BRAND_PROFILE_SETTING_KEY } });
  });

  it('ignores missing, secret, invalid, oversized or unreadable profiles instead of blocking generation', async () => {
    await expect(service(jest.fn().mockResolvedValue(null)).load()).resolves.toBeNull();
    await expect(service(jest.fn().mockResolvedValue({ value: profile, secret: true })).load()).resolves.toBeNull();
    await expect(service(jest.fn().mockRejectedValue(new Error('db down'))).load()).resolves.toBeNull();
    expect(parseBrandProfile({ ...profile, unknown: true })).toBeNull();
    expect(parseBrandProfile({ links: [{ label: 'x', url: 'not a url' }] })).toBeNull();
    expect(parseBrandProfile({ facts: Array.from({ length: 30 }, () => 'x'.repeat(300)) })).toBeNull();
  });

  it('renders the profile as a delimited data block', () => {
    const block = brandProfileBlock(parseBrandProfile(profile));
    expect(block).toMatch(/^<brand_facts>\n/);
    expect(block).toContain('- VPS NVMe, đặt tại Hà Nội và TP.HCM');
    expect(block).toContain('- Bảng giá: https://vpsttt.com/bang-gia');
    expect(block).toContain('Disclosure line for forums and communities: Mình làm ở VPSTTT.');
    expect(brandProfileBlock(null)).toBe('');
    expect(brandProfileBlock({})).toBe('');
  });
});
