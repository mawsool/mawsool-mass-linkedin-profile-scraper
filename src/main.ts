import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';

type Mode = 'company' | 'details' | 'watch' | 'mass';
type Input = {
    urls?: string[];
    urlsCsv?: string;
    fileUrl?: string;
    maxUrls?: number;
    concurrency?: number;
    previousCompanies?: Record<string, string>;
    webhookUrl?: string;
    stateStoreName?: string;
    watchId?: string;
    resumeId?: string;
    freshStart?: boolean;
};
type InputRow = { url: string; previousCompany?: string };

const MODE = (process.env.ACTOR_MODE || 'company') as Mode;
const API_BASE = (process.env.GUEST_API_BASE_URL).replace(/\/+$/, '');
const API_KEY = process.env.GUEST_API_KEY?.trim();
const EVENT = process.env.CHARGE_EVENT || (MODE === 'company' ? 'company-check' : MODE === 'watch' ? 'job-check' : 'profile-details');
const ENDPOINT = MODE === 'company' || MODE === 'watch' ? 'company' : 'full';
const DEFAULT_MAX = MODE === 'mass' ? 10000 : 100;
const HARD_MAX = MODE === 'mass' || MODE === 'company' ? 1_000_000 : MODE === 'watch' ? 100_000 : 50_000;

function normalizeUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    try {
        const url = new URL(value.startsWith('http') ? value : `https://${value}`);
        if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !url.pathname.toLowerCase().includes('/in/')) return null;
        url.protocol = 'https:';
        url.hostname = 'www.linkedin.com';
        url.search = '';
        url.hash = '';
        url.pathname = url.pathname.replace(/\/+$/, '');
        return url.toString();
    } catch {
        return null;
    }
}

function parseCsv(text: string): InputRow[] {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return [];
    const split = (line: string) => line.split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
    const first = split(lines[0]).map((part) => part.toLowerCase());
    const hasHeader = first.some((part) => ['url', 'linkedinurl', 'linkedin_url', 'previouscompany', 'company'].includes(part));
    const urlIndex = hasHeader ? Math.max(first.findIndex((part) => ['url', 'linkedinurl', 'linkedin_url'].includes(part)), 0) : 0;
    const previousIndex = hasHeader ? first.findIndex((part) => ['previouscompany', 'previous_company', 'company'].includes(part)) : 1;
    return lines.slice(hasHeader ? 1 : 0).map((line) => {
        const cols = split(line);
        return { url: cols[urlIndex] || '', ...(previousIndex >= 0 && cols[previousIndex] ? { previousCompany: cols[previousIndex] } : {}) };
    });
}

async function collectRows(input: Input): Promise<InputRow[]> {
    const rows: InputRow[] = [];
    for (const url of input.urls || []) rows.push({ url });
    if (input.urlsCsv) rows.push(...parseCsv(input.urlsCsv));
    if (input.fileUrl) {
        const response = await fetch(input.fileUrl, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Could not download input file (HTTP ${response.status}).`);
        rows.push(...parseCsv(await response.text()));
    }
    const seen = new Set<string>();
    const normalized: InputRow[] = [];
    for (const row of rows) {
        const url = normalizeUrl(row.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        normalized.push({
            url,
            previousCompany: row.previousCompany || input.previousCompanies?.[url],
        });
    }
    return normalized;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const DIRECT_ATTEMPTS = 5;
const LOOKUP_TIMEOUT_MS = 45_000;

function cleanError(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : fallback;
    return message.replace(/https?:\/\/\S+/gi, 'the lookup service');
}

function permanentStatus(status: number): boolean {
    return status === 400 || status === 401 || status === 402 || status === 404 || status === 409 || status === 422;
}

function stalled(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return error.name === 'TimeoutError' || error.name === 'AbortError' || message.includes('fetch failed') || message.includes('network') || message.includes('timed out');
}

function backoff(attempt: number): number {
    return Math.min(8000, 1000 * (2 ** attempt));
}

async function apiLookup(url: string): Promise<Record<string, unknown>> {
    let lastError = 'Lookup failed';
    for (let attempt = 0; attempt < DIRECT_ATTEMPTS; attempt += 1) {
        try {
            const response = await fetch(`${API_BASE}`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': `Mawsool-Apify-${MODE}/1.0`,
                    'x-api-key': API_KEY!,
                },
                body: JSON.stringify({ url }),
                signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
            });
            const text = await response.text();
            let body: Record<string, unknown> | null = null;
            try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* handled below */ }
            if (response.ok && body) return body;
            lastError = body && typeof body.error === 'string' ? body.error : `API returned HTTP ${response.status}`;
            if (permanentStatus(response.status)) break;
            log.warning(`Lookup attempt ${attempt + 1} of ${DIRECT_ATTEMPTS} did not succeed. Retrying.`);
        } catch (error) {
            lastError = stalled(error) ? 'The lookup did not answer in time.' : cleanError(error, 'Network request failed');
            log.warning(`Lookup attempt ${attempt + 1} of ${DIRECT_ATTEMPTS} did not succeed. Retrying.`);
        }
        if (attempt < DIRECT_ATTEMPTS - 1) await sleep(backoff(attempt));
    }
    throw new Error(lastError.replace(/https?:\/\/\S+/gi, 'the lookup service'));
}

function slugHash(url: string): string {
    return createHash('sha256').update(url).digest('hex');
}

function companyChanged(previous: unknown, current: unknown): boolean {
    const clean = (value: unknown) => String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
    return !!clean(previous) && clean(previous) !== clean(current);
}

async function postWebhook(webhookUrl: string, changes: Record<string, unknown>[]): Promise<void> {
    if (!changes.length) return;
    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== 'https:') throw new Error('webhookUrl must use HTTPS.');
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mawsool-Apify-Job-Watch/1.0' },
        body: JSON.stringify({ actor: 'mawsool-linkedin-job-change-watch', changes }),
    });
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}.`);
}

await Actor.init();
if (!API_KEY) throw new Error('GUEST_API_KEY is not configured as an Apify secret.');

const input = (await Actor.getInput<Input>()) || {};
const requestedMax = Number(input.maxUrls ?? DEFAULT_MAX);
const maxUrls = Math.min(Math.max(requestedMax, 1), HARD_MAX);
const rows = (await collectRows(input)).slice(0, maxUrls);
if (!rows.length) throw new Error('No valid LinkedIn profile URLs found. Add URLs, paste CSV, or upload a CSV file.');

const concurrency = Math.min(Math.max(Number(input.concurrency ?? (MODE === 'mass' ? 30 : 10)), 1), MODE === 'mass' ? 100 : 40);
const stateStore = MODE === 'watch'
    ? await Actor.openKeyValueStore(input.stateStoreName || 'mawsool-linkedin-job-watch')
    : null;
const progressId = (input.resumeId || 'auto').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60) || 'auto';
const saveProgress = MODE !== 'watch' && (MODE === 'mass' || rows.length > 20 || !!input.resumeId);
const skipFinished = saveProgress && !input.freshStart && (rows.length > 200 || !!input.resumeId || (MODE === 'mass' && rows.length > 20));
const resumeStore = saveProgress
    ? await Actor.openKeyValueStore(input.resumeId ? `mawsool-${MODE}-resume-${progressId}` : `mawsool-${MODE}-progress-auto`)
    : null;
const watchPrefix = (input.watchId || 'default').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 50);

log.info(`Starting ${rows.length} ${MODE} lookup(s), concurrency=${concurrency}`);
if (skipFinished) log.info('Finished rows from an earlier run of this list are skipped. Set freshStart to look them up again.');

let batch = rows;
let deferFailures = rows.length > 1;
let nextIndex = 0;
const deferred: InputRow[] = [];
let processed = 0;
let succeeded = 0;
let failed = 0;
let changed = 0;
let skipped = 0;
let stop = false;
let consecutiveOutages = 0;
function noteOutcome(message: string | null): void {
    if (!message) {
        consecutiveOutages = 0;
        return;
    }
    const text = message.toLowerCase();
    const outage = text.includes('did not answer') || text.includes('timed out') || text.includes('fetch failed') || text.includes('network') || text.includes('unavailable') || text.includes('unexpected response') || text.includes('403') || text.includes('429') || text.includes('502') || text.includes('503') || text.includes('504');
    if (!outage) {
        consecutiveOutages = 0;
        return;
    }
    consecutiveOutages += 1;
    if (consecutiveOutages >= 15 && !stop) {
        stop = true;
        log.error('The lookup service looks unavailable. Stopping so finished rows stay saved and the next run can continue.');
    }
}
const webhookChanges: Record<string, unknown>[] = [];

async function worker(): Promise<void> {
    while (!stop) {
        const index = nextIndex++;
        if (index >= batch.length) return;
        const item = batch[index];
        const recordKey = slugHash(item.url);

        if (skipFinished && resumeStore && await resumeStore.getValue(`done-${recordKey}`)) {
            skipped += 1;
            continue;
        }

        try {
            const api = await apiLookup(item.url);
            let row: Record<string, unknown>;

            if (MODE === 'company') {
                row = {
                    inputUrl: item.url,
                    ...api,
                    ...(item.previousCompany
                        ? {
                            previousCompany: item.previousCompany,
                            needsUpdate: companyChanged(item.previousCompany, api.company),
                        }
                        : {}),
                    success: true,
                    checkedAt: new Date().toISOString(),
                };
                const charge = await Actor.pushData(row, EVENT);
                if (charge?.eventChargeLimitReached) stop = true;
            } else if (MODE === 'watch') {
                const stateKey = `${watchPrefix}-${recordKey}`;
                const previous = await stateStore!.getValue<Record<string, unknown>>(stateKey);
                const companyHasChanged = !!previous && companyChanged(previous.company, api.company);
                const headlineHasChanged = !!previous && companyChanged(previous.headline, api.headline);
                const changeType = !previous
                    ? 'baseline'
                    : companyHasChanged
                        ? 'company_changed'
                        : headlineHasChanged
                            ? 'headline_changed'
                            : 'unchanged';
                row = {
                    inputUrl: item.url,
                    linkedinNumId: api.linkedin_num_id || null,
                    fullName: api.full_name || null,
                    previousCompany: previous?.company || null,
                    currentCompany: api.company || null,
                    previousHeadline: previous?.headline || null,
                    currentHeadline: api.headline || null,
                    needsUpdate: companyHasChanged || headlineHasChanged,
                    changeType,
                    checkedAt: new Date().toISOString(),
                    success: true,
                };
                const charge = await Actor.charge({ eventName: EVENT, count: 1 });
                if (charge?.eventChargeLimitReached) {
                    stop = true;
                    return;
                }
                if (changeType !== 'unchanged') {
                    await Actor.pushData(row);
                    if (changeType !== 'baseline') {
                        changed += 1;
                        webhookChanges.push(row);
                    }
                }
                await stateStore!.setValue(stateKey, {
                    company: api.company || null,
                    headline: api.headline || null,
                    fullName: api.full_name || null,
                    firstSeenAt: previous?.firstSeenAt || new Date().toISOString(),
                    lastCheckedAt: new Date().toISOString(),
                });
            } else {
                // Preserve every field returned by /full, including nulls and empty arrays.
                row = { ...api, inputUrl: item.url, success: true, checkedAt: new Date().toISOString() };
                const charge = await Actor.pushData(row, EVENT);
                if (charge?.eventChargeLimitReached) stop = true;
                if (resumeStore) await resumeStore.setValue(`done-${recordKey}`, { at: new Date().toISOString() });
            }
            noteOutcome(null);
            processed += 1;
            succeeded += 1;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unexpected lookup error';
            noteOutcome(message);
            if (deferFailures && !stop) {
                deferred.push(item);
                log.warning(`Lookup failed and will be retried at the end: ${message}`);
                continue;
            }
            const row = {
                inputUrl: item.url,
                success: false,
                error: message,
                checkedAt: new Date().toISOString(),
            };
            const charge = await Actor.pushData(row, EVENT);
            if (charge?.eventChargeLimitReached) stop = true;
            processed += 1;
            failed += 1;
            log.warning(`Failed ${item.url}: ${message}`);
        }
    }
}

async function runBatch(): Promise<void> {
    nextIndex = 0;
    const workers = Math.min(concurrency, batch.length);
    if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()));
}

await runBatch();
if (deferred.length && !stop) {
    log.info(`Retrying ${deferred.length} lookup(s) that failed on the first pass.`);
    await sleep(3000);
    batch = deferred.splice(0, deferred.length);
    deferFailures = false;
    await runBatch();
}

if (MODE === 'watch' && input.webhookUrl && webhookChanges.length) {
    try {
        await postWebhook(input.webhookUrl, webhookChanges);
    } catch (error) {
        log.error(`Change webhook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

await Actor.setValue('OUTPUT', {
    mode: MODE,
    requested: rows.length,
    processed,
    succeeded,
    failed,
    changed,
    skipped,
    stoppedByChargeLimit: stop,
});
log.info(`Finished. Processed=${processed}, succeeded=${succeeded}, failed=${failed}, changed=${changed}, skipped=${skipped}`);
await Actor.exit();
