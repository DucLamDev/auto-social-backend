import { validate } from 'class-validator';
import { MEDIA_ALT_TEXT_MAX_LENGTH, UploadMediaDto } from './upload-media.dto';

describe('UploadMediaDto', () => {
  it('accepts optional alt text within the documented limit', async () => {
    const dto = Object.assign(new UploadMediaDto(), { altText: 'Architecture diagram' });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects alt text longer than the documented limit', async () => {
    const dto = Object.assign(new UploadMediaDto(), {
      altText: 'a'.repeat(MEDIA_ALT_TEXT_MAX_LENGTH + 1),
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.constraints).toHaveProperty('maxLength');
  });
});
