import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Game/Native IO replacements only. Real defineStep, OCR adapter and error policy are loaded below.
async function scenario(options = {}) {
    const epoch = Date.UTC(2026, 10, 5, 20, 35);
    const state = { now: 0, pans: 0, presses: 0, sequence: 0, heading: 350,
        cancelled: false, snapshots: 0, disposed: 0, pendingPositive: false,
        positive: !!options.positive, calls: [] };
    const parentError = new Error('parent deadline reached');
    const cancelError = new Error('取消自动任务');
    function guard() {
        if (state.cancelled || (options.cancelAt != null && state.now >= options.cancelAt)) throw cancelError;
        if (state.now >= (options.parentDeadline ?? Infinity)) throw parentError;
    }
    function results(texts) { const list = texts.map(text => ({ text })); list.count = list.length; return list; }
    function completed() { return options.completed === true || (options.completeAfterT !== false && state.presses > 0); }
    function failure() { return state.now >= (options.failureAt ?? 60000) ? '挑战失败' : null; }
    function activeTexts() {
        if (options.active === false) return ['在限定时间内抵达终点'];
        if (options.active === 'unknown') return [];
        if (options.active === 'zero') return ['剩余时间：0秒', '中断挑战'];
        return ['剩余时间：55秒', '中断挑战'];
    }
    const moon = Object.freeze({ name: 'existing MoonLightIcon asset' });
    const main = Object.freeze({ name: 'existing main UI asset' });
    class Rect { constructor(x, y, width, height) { Object.assign(this, { X:x, Y:y, Width:width, Height:height }); } }
    class Page {
        Ocr(rect) {
            guard();
            if (options.ocrCost) state.now += options.ocrCost;
            if (rect) return results(completed() ? ['委托完成'] : []);
            return results(failure() ? [failure()] : []);
        }
        locator(ro) { return { isExist() { guard(); return ro === moon && state.positive; } }; }
    }
    function capture() {
        guard(); state.snapshots++;
        const framePositive = state.positive || (options.positiveInFirstCapture && state.snapshots === 1);
        const sequence = options.repeatedSource ? 1 : ++state.sequence;
        const capturedAt = epoch + state.now - (options.stale ? 5000 : 0);
        const source = {
            IsKnown: options.unknownSource !== true,
            SessionId: 'same-capture-session', Sequence: sequence,
            CapturedTimestamp: 10000000000 + (state.now - (options.stale ? 5000 : 0)) * 10000, TimestampFrequency: 10000000,
            CapturedAt: { ToUnixTimeMilliseconds: () => capturedAt },
            IsAfter(previous) { return this.SessionId === previous.SessionId && this.Sequence > previous.Sequence && this.CapturedTimestamp >= previous.CapturedTimestamp; }
        };
        return {
            FrameStamp: source,
            find(ro) { guard(); return { isExist: () => ro === moon ? framePositive : ro === main && options.mainUi !== false }; },
            DeriveCrop() {
                return { findMulti() {
                    guard(); if (options.activityCost) state.now += options.activityCost;
                    return results(activeTexts());
                }, Dispose() {} };
            },
            Dispose() { state.disposed++; }
        };
    }
    class Clock extends Date { static now() { return epoch + state.now; } }
    const context = vm.createContext({
        Date: Clock, OpenCvSharp: { OpenCvSharp: { Rect } }, BvPage: Page,
        RecognitionObject: { ocrThis: Object.freeze({ kind: 'ocr' }) },
        log: { info() {}, debug() {}, warn() {}, error() {} },
        pathingScript: { get isCancellationRequested() { guard(); return false; } },
        captureGameRegion: capture,
        genshin: { getCameraOrientation() {
            guard();
            if (options.cameraCost) state.now += options.cameraCost;
            if (options.cameraError) throw options.cameraError;
            return options.unknownCamera ? NaN : state.heading;
        } },
        moveMouseBy(dx, dy) {
            guard(); state.calls.push({ kind: 'camera', dx, dy, at: state.now }); state.pans++;
            state.heading = (state.heading + (options.angleJump ?? dx / 8) + 360) % 360;
            if (state.pans >= (options.revealAfterPans ?? 1)) state.pendingPositive = true;
        },
        keyPress(key) {
            guard(); state.calls.push({ kind: 'key', key, at: state.now });
            assert.equal(key, 't', 'candidate may not add displacement or other keys');
            state.presses++;
            if (options.hideAfterT) state.positive = false;
        },
        async sleep(ms) {
            guard(); state.calls.push({ kind: 'sleep', ms, at: state.now });
            state.now += ms;
            if (state.pendingPositive && options.neverPositive !== true) state.positive = true;
            guard();
        }
    });
    const modules = new Map();
    async function load(filename) {
        if (modules.has(filename)) return modules.get(filename);
        let module;
        if (filename.endsWith('/vision/index.js')) {
            module = new vm.SyntheticModule(['RO'], function() { this.setExport('RO', { moonLightIcon:moon, inMainUI:main }); }, { context, identifier:filename });
        } else {
            const source = await readFile(filename, 'utf8');
            module = new vm.SourceTextModule(source, { context, identifier:filename });
        }
        modules.set(filename, module);
        await module.link(async (specifier, importer) => {
            const dependency = resolve(dirname(importer.identifier), specifier).replaceAll('\\','/');
            if (!dependency.startsWith(root.replaceAll('\\','/') + '/src/')) throw new Error('Unapproved import: ' + dependency);
            return load(dependency);
        });
        return module;
    }
    const entry = resolve(root, 'src/processors/music-flow.js').replaceAll('\\','/');
    const module = await load(entry);
    await module.evaluate();
    return { state, parentError, cancelError, async run() {
        return module.namespace.default.handler({ type:'乐流奔引' }, { commissionName:'乐流奔引' });
    } };
}

test('whole step acquires an absent T affordance using camera and then follows the original T branch', async () => {
    const game = await scenario();
    assert.equal(await game.run(), true);
    assert.ok(game.state.pans > 0, 'camera must acquire the positive state instead of passively waiting');
    assert.equal(game.state.presses, 1);
    assert.equal(game.state.calls.find(call => call.kind !== 'sleep').kind, 'camera');
    assert.equal(game.state.snapshots, game.state.disposed);
});

test('an initial positive affordance retires acquisition even if later prompts disappear', async () => {
    const game = await scenario({ positive:true, hideAfterT:true, completeAfterT:false, neverPositive:true, failureAt:5000 });
    await assert.rejects(game.run(), /MUSIC_FLOW_FAILED/);
    assert.equal(game.state.pans, 0, 'do not start a new scan during the original post-T traversal');
    assert.equal(game.state.presses, 1);
});

test('parent deadline wins if completion OCR returns after the parent expired', async () => {
    const game = await scenario({ completed:true, parentDeadline:5, ocrCost:10 });
    await assert.rejects(game.run(), error => error === game.parentError);
    assert.equal(game.state.calls.filter(call => call.kind !== 'sleep').length, 0);
});

test('initial positive affordance follows the original T branch without acquiring camera', async () => {
    const game = await scenario({ positive:true });
    assert.equal(await game.run(), true);
    assert.equal(game.state.pans, 0);
    assert.equal(game.state.presses, 1);
});

for (const [name, options] of [
    ['negative active status', { active:false }],
    ['stale source', { stale:true }],
    ['unknown source', { unknownSource:true }],
    ['unknown camera', { unknownCamera:true }],
]) {
    test(name + ' cannot authorize camera or blind T', async () => {
        const game = await scenario({ ...options, neverPositive:true, failureAt:4000 });
        await assert.rejects(game.run(), /MUSIC_FLOW_FAILED/);
        assert.equal(game.state.pans, 0);
        assert.equal(game.state.presses, 0);
        assert.equal(game.state.snapshots, game.state.disposed);
    });
}

test('camera count and measured travel are finite without resetting the original deadline', async () => {
    for (const [angleJump, maximum] of [[undefined,9],[0,12],[100,1]]) {
        const game = await scenario({ angleJump, neverPositive:true, failureAt:Infinity });
        await assert.rejects(game.run(), /MUSIC_FLOW_TIMEOUT/);
        assert.equal(game.state.pans, maximum);
        assert.equal(game.state.presses, 0);
        assert.equal(game.state.now, 120000);
        assert.ok(game.state.calls.filter(call => call.kind === 'camera').every(call =>
            call.dy === 0 && Math.abs(call.dx) === 80 && call.at < 120000));
        assert.ok(game.state.calls.filter(call => call.kind === 'sleep').every(call => call.ms === 500));
    }
});

test('a repeated source cannot authorize additional camera actions', async () => {
    const game = await scenario({ repeatedSource:true, neverPositive:true, failureAt:4000 });
    await assert.rejects(game.run(), /MUSIC_FLOW_FAILED/);
    assert.equal(game.state.pans, 1);
    assert.equal(game.state.presses, 0);
});

test('completion and explicit failure retain priority over input', async () => {
    const complete = await scenario({ completed:true, positive:true });
    assert.equal(await complete.run(), true);
    assert.equal(complete.state.calls.filter(call => call.kind !== 'sleep').length, 0);
    const failed = await scenario({ positive:true, failureAt:0 });
    await assert.rejects(failed.run(), /MUSIC_FLOW_FAILED/);
    assert.equal(failed.state.calls.filter(call => call.kind !== 'sleep').length, 0);
});

test('cancellation before acquisition propagates unchanged without input', async () => {
    const game = await scenario({ cancelAt:0 });
    await assert.rejects(game.run(), error => error === game.cancelError);
    assert.equal(game.state.calls.length, 0);
});

test('parent expiry during camera observation cannot dispatch a late action', async () => {
    const game = await scenario({ parentDeadline:200, cameraCost:250 });
    await assert.rejects(game.run(), error => error === game.parentError);
    assert.equal(game.state.calls.filter(call => call.kind !== 'sleep').length, 0);
    assert.equal(game.state.snapshots, game.state.disposed);
});

test('the original absolute step deadline is checked again after slow observations', async () => {
    const game = await scenario({ positive:true, ocrCost:60000, failureAt:Infinity });
    await assert.rejects(game.run(), /MUSIC_FLOW_TIMEOUT/);
    assert.equal(game.state.calls.filter(call => call.kind !== 'sleep').length, 0);
    assert.equal(game.state.now, 120000);
});

test('original T cadence and count are not increased when the positive template persists', async () => {
    const game = await scenario({ positive:true, completeAfterT:false, failureAt:Infinity });
    await assert.rejects(game.run(), /MUSIC_FLOW_TIMEOUT/);
    const keys = game.state.calls.filter(call => call.kind === 'key');
    assert.equal(game.state.pans, 0);
    assert.equal(keys.length, 48);
    assert.deepEqual(keys.map(call => call.at), Array.from({length:48}, (_, i) => i * 2500));
    assert.ok(game.state.calls.filter(call => call.kind === 'sleep').every(call => call.ms === 500 || call.ms === 2000));
});

test('negative outer frame followed by positive active capture retires camera and uses the original T branch', async () => {
    const game = await scenario({ positiveInFirstCapture:true });
    assert.equal(await game.run(), true);
    assert.equal(game.state.pans, 0, 'a newer positive capture must not be rotated away');
    assert.equal(game.state.presses, 1);
    assert.equal(game.state.calls.find(call => call.kind !== 'sleep').kind, 'key');
    assert.equal(game.state.snapshots, game.state.disposed);

    const continuing = await scenario({ positiveInFirstCapture:true, neverPositive:true, completeAfterT:false, failureAt:5000 });
    await assert.rejects(continuing.run(), /MUSIC_FLOW_FAILED/);
    assert.equal(continuing.state.pans, 0, 'the positive capture permanently retires acquisition for the remaining traversal');
    assert.equal(continuing.state.presses, 1);
    assert.equal(continuing.state.snapshots, continuing.state.disposed);
});
