import { parseExtensionDeliverySettings } from '../connectors/extension/extension-delivery';
import { extensionFlowForPlatform, validateExtensionFlow } from '../connectors/extension/extension-flows';

export type DefaultDelivery =
  | { status: 'READY'; settings: Record<string, unknown> }
  | { status: 'DESTINATION_REQUIRED' | 'FLOW_REQUIRED' }
  | { status: 'INVALID'; error: string };

/**
 * The posting route an extension account gets without anyone filling the
 * "Tiện ích" form: its platform's flow and new-post page. The page comes from
 * the given override, else the one already on the account, else the flow's own
 * default. Returns the settings to merge, or why the account cannot post yet.
 */
export function defaultExtensionDelivery(
  platformSlug: string,
  settings: Record<string, unknown>,
  overrides: { targetUrl?: string; tags?: string[]; category?: string } = {},
): DefaultDelivery {
  const flow = extensionFlowForPlatform(platformSlug);
  if (!flow) return { status: 'FLOW_REQUIRED' };
  const stored = typeof settings.extensionTargetUrl === 'string' ? settings.extensionTargetUrl.trim() : '';
  const targetUrl = overrides.targetUrl?.trim() || stored || flow.targetUrl;
  if (!targetUrl) return { status: 'DESTINATION_REQUIRED' };
  try {
    // "Tự bấm Đăng" stays off on an account where the owner switched it off.
    const autoSubmit = settings.extensionAutoSubmit !== false;
    const target = parseExtensionDeliverySettings({
      extensionEngine: flow.engine,
      extensionTargetUrl: targetUrl,
      extensionAutoSubmit: autoSubmit,
      extensionTags: overrides.tags ?? (Array.isArray(settings.extensionTags) ? settings.extensionTags : []),
      extensionCategory: overrides.category || (typeof settings.extensionCategory === 'string' ? settings.extensionCategory : ''),
    });
    validateExtensionFlow(platformSlug, target);
    return {
      status: 'READY',
      settings: {
        delivery: 'extension', extensionEngine: target.engine, extensionTargetUrl: target.targetUrl, extensionAutoSubmit: autoSubmit,
        extensionTags: target.tags ?? [], extensionCategory: target.category ?? '', extensionFlowId: flow.id, extensionFlowRevision: flow.revision,
        extensionSetup: { status: 'READY' },
      },
    };
  } catch (error) {
    return { status: 'INVALID', error: error instanceof Error ? error.message : String(error) };
  }
}
