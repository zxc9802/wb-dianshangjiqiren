import { randomUUID } from 'node:crypto';
import { usageContext } from './usage-context';
import { recordUsage, type UsageEvent } from './usage-ledger';
import { emptyUsage, mergeUsage, parseTokenUsage } from './usage-values';

/** Observe server-side provider calls without retaining prompts, keys or generated content. */
export async function usageFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const context = usageContext.getStore();
    if (!context) return fetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
        try { body = JSON.parse(init.body); } catch { /* Non-JSON provider request. */ }
    }
    const event: UsageEvent = {
        ...emptyUsage(), ...context, requestId: randomUUID(), provider: url.hostname,
        model: typeof body.model === 'string' ? body.model : decodeURIComponent(url.pathname.match(/\/models\/([^/:]+)/)?.[1] ?? 'unknown'),
        status: 'pending', tokenBasis: 'missing',
    };
    await recordUsage(event);
    // OpenAI-compatible streams omit the final usage packet unless explicitly requested.
    if (body.stream === true && url.pathname.endsWith('/chat/completions')) {
        init = { ...init, body: JSON.stringify({ ...body, stream_options: { ...(body.stream_options as object ?? {}), include_usage: true } }) };
    }
    let response: Response;
    try { response = await fetch(input, init); }
    catch (error) { await recordUsage({ ...event, status: 'failed' }); throw error; }
    event.upstreamRequestId = response.headers.get('x-request-id');
    let observedError = false;
    let terminal = false;
    const observe = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(observe); return; }
        if (value && typeof value === 'object' && 'type' in value && ['message_stop', 'response.completed', 'response.failed'].includes(String(value.type))) terminal = true;
        Object.assign(event, mergeUsage(event, parseTokenUsage(value)));
        if (value && typeof value === 'object' && (('error' in value && Boolean(value.error)) || ('type' in value && ['error', 'response.failed', 'response.incomplete'].includes(String(value.type))))) observedError = true;
        event.tokenBasis = event.totalTokens !== null || event.inputTokens !== null || event.outputTokens !== null ? 'reported' : 'missing';
    };
    if (!response.body) {
        await recordUsage({ ...event, status: response.ok ? 'completed' : 'failed' });
        return response;
    }
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    if (!sse) {
        let bytes: ArrayBuffer;
        try { bytes = await response.arrayBuffer(); }
        catch (error) { await recordUsage({ ...event, status: 'interrupted' }); throw error; }
        try { observe(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* Usage is unavailable. */ }
        await recordUsage({ ...event, status: response.ok && !observedError ? 'completed' : 'failed' });
        return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    const consume = (chunk: string) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            if (line.slice(5).trim() === '[DONE]') terminal = true;
            try { observe(JSON.parse(line.slice(5).trim())); } catch { /* Includes [DONE]. */ }
        }
        // A malformed provider must not cause unlimited buffering.
        if (pending.length > 2_000_000) pending = '';
    };
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const part = await reader.read();
                if (part.done) {
                    consume(decoder.decode() + '\n');
                    await recordUsage({ ...event, status: response.ok && !observedError ? 'completed' : 'failed' });
                    controller.close();
                } else {
                    consume(decoder.decode(part.value, { stream: true }));
                    if (terminal) await recordUsage({ ...event, status: response.ok && !observedError ? 'completed' : 'failed' });
                    controller.enqueue(part.value);
                }
            } catch (error) {
                await recordUsage({ ...event, status: 'interrupted' });
                controller.error(error);
            }
        },
        async cancel(reason) {
            try { await reader.cancel(reason); }
            finally { await recordUsage({ ...event, status: 'interrupted' }); }
        },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
