export const RESPONSE_MODEL_VALUES = [
    'gemini',
    'gemini-deep-thinking',
    'gpt-5.4',
    'gpt-5.6-luna',
    'claude-opus-4.6',
] as const;

export type ResponseModel = typeof RESPONSE_MODEL_VALUES[number];

export const RESPONSE_MODEL_OPTIONS = [
    { value: 'gemini', label: 'Gemini' },
    { value: 'gpt-5.4', label: 'GPT-5.5' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6' },
    { value: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
] as const satisfies ReadonlyArray<{ value: ResponseModel; label: string }>;

const OPENAI_UPSTREAM_MODEL_BY_RESPONSE_MODEL = {
    'gpt-5.4': 'gpt-5.5',
    'gpt-5.6-luna': 'gpt-5.6-luna',
} as const;

export type OpenAIResponseModel = keyof typeof OPENAI_UPSTREAM_MODEL_BY_RESPONSE_MODEL;

export const DEFAULT_RESPONSE_MODEL: ResponseModel = 'gemini';

export const RESPONSE_MODEL_STORAGE_PREFIX = 'chat-response-model:';

export const WEB_SEARCH_MODE_VALUES = ['auto', 'on', 'off'] as const;

export type WebSearchMode = typeof WEB_SEARCH_MODE_VALUES[number];

export const WEB_SEARCH_MODE_OPTIONS = [
    { value: 'auto', label: '联网自动' },
    { value: 'on', label: '联网开启' },
    { value: 'off', label: '联网关闭' },
] as const satisfies ReadonlyArray<{ value: WebSearchMode; label: string }>;

export const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = 'auto';

export const WEB_SEARCH_MODE_STORAGE_PREFIX = 'chat-web-search-mode:';

export function isResponseModel(value: unknown): value is ResponseModel {
    return typeof value === 'string' && RESPONSE_MODEL_VALUES.includes(value as ResponseModel);
}

export function isSelectableResponseModel(value: unknown): value is ResponseModel {
    return typeof value === 'string' && RESPONSE_MODEL_OPTIONS.some((option) => option.value === value);
}

export function isOpenAIResponseModel(value: unknown): value is OpenAIResponseModel {
    return typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(OPENAI_UPSTREAM_MODEL_BY_RESPONSE_MODEL, value);
}

export function getOpenAIUpstreamModel(value: unknown): string | null {
    return isOpenAIResponseModel(value) ? OPENAI_UPSTREAM_MODEL_BY_RESPONSE_MODEL[value] : null;
}

export function isWebSearchMode(value: unknown): value is WebSearchMode {
    return typeof value === 'string' && WEB_SEARCH_MODE_VALUES.includes(value as WebSearchMode);
}

export function getResponseModelLabel(model: ResponseModel): string {
    return RESPONSE_MODEL_OPTIONS.find((option) => option.value === model)?.label || model;
}

export function getWebSearchModeLabel(mode: WebSearchMode): string {
    return WEB_SEARCH_MODE_OPTIONS.find((option) => option.value === mode)?.label || mode;
}
