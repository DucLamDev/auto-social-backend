import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { FormControlDto, FormFillRequestDto } from './form-fill.dto';
import { describeControl, FORM_FILL_SPEC, FormControl, isProtectedControl, sanitizeControls, validateFormActions } from './form-fill.rules';

const base = { required: false, invalid: false };
const controls: FormControl[] = [
  { index: 0, kind: 'select', tag: 'select', id: 'post-language', label: 'Language', ...base, selected: 'Undetermined',
    options: [{ value: '0', label: 'Undetermined' }, { value: '37', label: 'English' }, { value: '98', label: 'Tiếng Việt' }], selector: '#post-language' },
  { index: 1, kind: 'combobox', tag: 'div', label: 'Community', ...base, required: true, invalid: true,
    options: [{ value: 'selfhosted@lemmy.world', label: 'selfhosted@lemmy.world' }, { value: 'linux@lemmy.ml', label: 'Linux' }], selector: '#community' },
  { index: 2, kind: 'checkbox', tag: 'input', type: 'checkbox', id: 'post-nsfw', label: 'NSFW', ...base, checked: false, selector: '#post-nsfw' },
  { index: 3, kind: 'text', tag: 'textarea', id: 'post-title', label: 'Title', ...base, required: true, selector: '#post-title' },
  { index: 4, kind: 'checkbox', tag: 'input', type: 'checkbox', label: 'Send me the newsletter', ...base, checked: false, selector: '#news' },
  { index: 5, kind: 'text', tag: 'input', type: 'text', label: 'Flair', ...base, selector: '#flair' },
  { index: 6, kind: 'text', tag: 'input', type: 'url', id: 'post-url', label: 'URL', ...base, selector: '#post-url' },
  { index: 7, kind: 'radio', tag: 'input', type: 'radio', name: 'kind', label: 'Text post', ...base, checked: false, selector: '#kind-text' },
  { index: 8, kind: 'select', tag: 'select', label: 'Post as', name: 'user', ...base, options: [{ value: 'a', label: 'alice@example.com' }], selector: '#as' },
  { index: 9, kind: 'checkbox', tag: 'input', type: 'checkbox', label: 'Mark as NSFW (18+)', ...base, required: true, checked: false, selector: '#adult' },
];
const answer = (actions: Array<{ index: number; action: string; value?: string | null; selector?: string }>, confidence = 0.9) => ({ actions, confidence });

describe('AI form fill rules', () => {
  it('keeps a select value only when it is one of the control options, mapping a label to its value', () => {
    expect(validateFormActions(answer([{ index: 0, action: 'select', value: 'English' }]), controls, 0.6).actions)
      .toEqual([{ index: 0, selector: '#post-language', action: 'select', value: '37' }]);
    expect(validateFormActions(answer([{ index: 0, action: 'select', value: '98' }]), controls, 0.6).actions[0]?.value).toBe('98');
    expect(validateFormActions(answer([{ index: 1, action: 'select', value: 'selfhosted@lemmy.world' }]), controls, 0.6).actions[0]?.value).toBe('selfhosted@lemmy.world');
    expect(validateFormActions(answer([{ index: 0, action: 'select', value: 'Klingon' }, { index: 1, action: 'select', value: 'not-a-community' }]), controls, 0.6).actions).toEqual([]);
  });

  it('drops unknown indexes, selector mismatches, wrong kinds and a second action on one control', () => {
    const result = validateFormActions(answer([
      { index: 42, action: 'check', value: null },
      { index: -1, action: 'check', value: null },
      { index: 2, action: 'check', value: null, selector: '#somewhere-else' },
      { index: 0, action: 'check', value: null },
      { index: 2, action: 'select', value: 'x' },
      { index: 0, action: 'type', value: 'English' },
      { index: 0, action: 'select', value: '37' },
      { index: 0, action: 'select', value: '98' },
    ]), controls, 0.6);
    expect(result.actions).toEqual([{ index: 0, selector: '#post-language', action: 'select', value: '37' }]);
  });

  it('never touches title / body, newsletter, account or link controls', () => {
    const result = validateFormActions(answer([
      { index: 3, action: 'type', value: 'A better title' },
      { index: 4, action: 'check', value: null },
      { index: 8, action: 'select', value: 'a' },
      { index: 6, action: 'type', value: 'https://evil.example' },
    ]), controls, 0.6);
    expect(result.actions).toEqual([]);
    expect(isProtectedControl(controls[3]!)).toBe(true);
    expect(isProtectedControl({ ...controls[5]!, label: 'Nội dung bài viết' })).toBe(true);
    expect(isProtectedControl({ ...controls[5]!, label: 'Code', type: 'password' })).toBe(true);
  });

  it('checks and unchecks only checkboxes and radios, and sets an adult flag only when the form requires it', () => {
    expect(validateFormActions(answer([{ index: 7, action: 'check', value: null }]), controls, 0.6).actions).toEqual([{ index: 7, selector: '#kind-text', action: 'check' }]);
    expect(validateFormActions(answer([{ index: 7, action: 'uncheck', value: null }]), controls, 0.6).actions).toEqual([]);
    // Already unchecked: nothing to do.
    expect(validateFormActions(answer([{ index: 2, action: 'uncheck', value: null }]), controls, 0.6).actions).toEqual([]);
    expect(validateFormActions(answer([{ index: 2, action: 'check', value: null }]), controls, 0.6).actions).toEqual([]);
    expect(validateFormActions(answer([{ index: 2, action: 'uncheck', value: null }]), [{ ...controls[0]!, index: 0 }, { ...controls[1]!, index: 1 }, { ...controls[2]!, checked: true }], 0.6).actions)
      .toEqual([{ index: 2, selector: '#post-nsfw', action: 'uncheck' }]);
    expect(validateFormActions(answer([{ index: 9, action: 'check', value: null }]), controls, 0.6).actions).toEqual([{ index: 9, selector: '#adult', action: 'check' }]);
  });

  it('types only short single-line text into plain text inputs', () => {
    expect(validateFormActions(answer([{ index: 5, action: 'type', value: '  Discussion\n' }]), controls, 0.6).actions).toEqual([{ index: 5, selector: '#flair', action: 'type', value: 'Discussion' }]);
    expect(validateFormActions(answer([{ index: 5, action: 'type', value: 'x'.repeat(201) }]), controls, 0.6).actions).toEqual([]);
    expect(validateFormActions(answer([{ index: 5, action: 'type', value: '   ' }]), controls, 0.6).actions).toEqual([]);
    expect(validateFormActions(answer([{ index: 5, action: 'type', value: null }]), controls, 0.6).actions).toEqual([]);
  });

  it('returns no action below the confidence threshold', () => {
    expect(validateFormActions(answer([{ index: 0, action: 'select', value: '37' }], 0.4), controls, 0.6)).toEqual({ actions: [], errorCode: 'LOW_CONFIDENCE' });
    expect(validateFormActions(answer([{ index: 0, action: 'select', value: '37' }], 0.6), controls, 0.6).errorCode).toBeUndefined();
  });

  it('describes controls to the AI without selectors, masking page text but keeping community names', () => {
    const described = controls.map(describeControl);
    const text = JSON.stringify(described);
    expect(text).not.toContain('#post-language');
    expect(text).not.toContain('selector');
    expect(text).toContain('selfhosted@lemmy.world');
    // A protected control shows no options (here an e-mail address).
    expect(described[8]).toMatchObject({ protected: true });
    expect(text).not.toContain('alice@example.com');
    expect(describeControl({ ...controls[5]!, label: 'Mã 0987654321 của an@example.com' }).label).toBe('Mã [số] của [email]');
  });

  it('requires control indexes to match their position and strips control characters', () => {
    const dto = { index: 0, kind: 'select', tag: 'SELECT', label: 'Lang\nuage', required: false, invalid: false, options: [{ value: 'en', label: 'English\t' }], selector: 'select#x' } as FormControlDto;
    expect(sanitizeControls([dto])[0]).toMatchObject({ tag: 'select', label: 'Lang uage', options: [{ value: 'en', label: 'English' }] });
    expect(() => sanitizeControls([{ ...dto, index: 1 }])).toThrow('position');
  });

  it('asks the AI for a strict answer shape', () => {
    expect(FORM_FILL_SPEC.zod.safeParse({ actions: [{ index: 0, action: 'select', value: '37' }], confidence: 0.8, reason: 'ok' }).success).toBe(true);
    expect(FORM_FILL_SPEC.zod.safeParse({ actions: [{ index: 0, action: 'delete', value: null }], confidence: 0.8, reason: 'ok' }).success).toBe(false);
    expect(FORM_FILL_SPEC.zod.safeParse({ actions: [], confidence: 1.5, reason: 'ok' }).success).toBe(false);
  });
});

describe('FormFillRequestDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: FormFillRequestDto });
  const control = { index: 0, kind: 'select', tag: 'select', required: true, invalid: false, options: [{ value: '37', label: 'English' }], selector: '#post-language' };

  it('accepts the controls the extension describes', async () => {
    await expect(validate({ url: 'https://lemmy.world/create_post', controls: [control, { ...control, index: 1, kind: 'checkbox', checked: false, options: undefined, selector: '#nsfw' }] }))
      .resolves.toBeInstanceOf(FormFillRequestDto);
  });

  it('rejects malformed, oversized or extra input', async () => {
    const bad = [
      { url: 'https://lemmy.world/create_post', controls: [] },
      { url: 'https://lemmy.world/create_post', controls: Array.from({ length: 61 }, (_value, index) => ({ ...control, index: Math.min(index, 59) })) },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, index: 60 }] },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, kind: 'password' }] },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, selector: '' }] },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, label: 'x'.repeat(121) }] },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, options: Array.from({ length: 41 }, () => ({ value: 'v', label: 'l' })) }] },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, options: [{ value: 'v'.repeat(121), label: 'l' }] }] },
      { url: 'https://lemmy.world/create_post', controls: [{ ...control, value: 'typed secret' }] },
      { url: 'javascript:alert(1)', controls: [control] },
    ];
    for (const body of bad) await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
