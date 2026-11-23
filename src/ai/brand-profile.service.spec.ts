import { BadRequestException } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { BRAND_EMAIL, BRAND_WEBSITE, hasBrandFooter } from '../platforms/brand-footer';
import { BrandProfileController } from './brand-profile.controller';
import { BRAND_PROFILE_SETTING_KEY, brandProfileBlock, BrandProfileService, parseBrandProfile, SUGGESTED_BRAND_PROFILE } from './brand-profile.service';

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
  return new BrandProfileService({ systemSetting: { findUnique } } as unknown as PrismaService, {} as AuditService);
}

function editable(saved: unknown) {
  const updatedAt = new Date('2026-11-20T08:00:00Z');
  const prisma = {
    systemSetting: {
      findUnique: jest.fn().mockResolvedValue(saved === undefined ? null : { value: saved, secret: false, updatedAt }),
      upsert: jest.fn(({ update }: { update: { value: unknown } }) => Promise.resolve({ value: update.value, secret: false, updatedAt })),
    },
  };
  const audit = { recordBestEffort: jest.fn().mockResolvedValue(undefined) };
  return { prisma, audit, profiles: new BrandProfileService(prisma as unknown as PrismaService, audit as unknown as AuditService) };
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
    expect(parseBrandProfile({ links: [{ label: 'x', url: 'javascript:alert(1)' }] })).toBeNull();
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

describe('brand profile settings', () => {
  it('is for admins only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, BrandProfileController)).toEqual([RoleName.ADMIN]);
  });

  it('shows the saved profile, flags one the AI ignores, and suggests a valid start without contact details', async () => {
    await expect(editable(profile).profiles.view()).resolves.toMatchObject({ profile, invalid: false, updatedAt: '2026-11-20T08:00:00.000Z' });
    await expect(editable({ facts: [''] }).profiles.view()).resolves.toMatchObject({ profile: null, invalid: true });
    await expect(editable(undefined).profiles.view()).resolves.toEqual({ profile: null, invalid: false, updatedAt: null, suggested: SUGGESTED_BRAND_PROFILE });
    // The footer carries the contacts; the profile never repeats them in posts.
    const suggested = JSON.stringify(SUGGESTED_BRAND_PROFILE);
    expect(parseBrandProfile(SUGGESTED_BRAND_PROFILE)).toEqual(SUGGESTED_BRAND_PROFILE);
    expect(hasBrandFooter(suggested)).toBe(false);
    expect(suggested).not.toContain(BRAND_WEBSITE.replace('https://', ''));
    expect(suggested).not.toContain(BRAND_EMAIL);
  });

  it('saves what the form edits, keeps the reading languages and records who changed it', async () => {
    const { prisma, audit, profiles } = editable(profile);
    const edited = { brandName: 'VPSTTT', oneLiner: 'VPS và proxy tại Việt Nam', facts: ['Datacenter VNPT'], links: [] };

    const view = await profiles.save(edited, 'admin-1');

    const value = { brandName: 'VPSTTT', oneLiner: 'VPS và proxy tại Việt Nam', facts: ['Datacenter VNPT'], defaultLanguage: 'vi', platformLanguages: { quora: 'vi' } };
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: BRAND_PROFILE_SETTING_KEY }, update: { value, secret: false } }));
    expect(audit.recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'admin-1', action: 'BRAND_PROFILE_UPDATED', before: profile, after: value }));
    expect(view).toMatchObject({ profile: value, invalid: false });
  });

  it('refuses an invalid or oversized profile with a message the operator can act on, and saves nothing', async () => {
    const { prisma, profiles } = editable(undefined);
    const refused = (input: unknown) => profiles.save(input).then(() => '', (error: BadRequestException) => (error.getResponse() as { message: string }).message ?? error.message);

    await expect(refused({ facts: ['Có', '  '], links: [{ label: 'Web', url: 'javascript:alert(1)' }] }))
      .resolves.toBe('Hồ sơ thương hiệu chưa hợp lệ: Thông tin AI được dùng dòng 2: đang trống; Liên kết dòng 1 (địa chỉ): không phải địa chỉ web http(s).');
    // The reading languages are not set from this form.
    await expect(refused({ defaultLanguage: 'en' })).resolves.toBe('Hồ sơ thương hiệu chưa hợp lệ: Trường không hỗ trợ: defaultLanguage.');
    await expect(refused({ facts: Array.from({ length: 30 }, () => 'x'.repeat(300)) })).resolves.toMatch(/dài quá 8 KB/);
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });
});
