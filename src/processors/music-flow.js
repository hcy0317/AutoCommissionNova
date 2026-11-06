/**
 * 乐流奔引步骤处理器
 * 循环识别 MoonLightIcon；完成才成功，失败或循环期限到达交回委托级重试。
 * 本地兼容修复：上游 1.0.3 的该循环没有失败/期限出口。
 */
import { RO } from "../vision/index.js";
import { bvPageOcrRegion, bvPageOcrRegionText } from "../vision/ocr-utils.js";
import { defineStep } from "./define-step.js";
import { rethrowIfCancellation } from "../utils/error-utils.js";

const CHECK_INTERVAL_MS = 500;
const LOOP_TIMEOUT_MS = 120000;
const FAILURE_CHECK_INTERVAL_MS = 2000;
const COMPLETION_REGION = new OpenCvSharp.OpenCvSharp.Rect(880, 165, 160, 45);
// Same 1080p status panel seen in S19 source3754/4159. It authorizes camera acquisition, never T or completion.
const ACTIVE_REGION = new OpenCvSharp.OpenCvSharp.Rect(40, 230, 420, 110);
const FRAME_MAX_AGE_MS = 150;
const CAMERA_STEP_X = 80;
const CAMERA_DIRECTIONS = [1, 1, 1, -1, -1, -1, -1, -1, -1, 1, 1, 1];
const CAMERA_MAX_TRAVEL_DEGREES = 90;
const CAMERA_MAX_OFFSET_DEGREES = 45;

function ensureWithinStep(started) {
    // Existing read-only script guard checks cancellation and the captured parent task before inputs.
    if (pathingScript.isCancellationRequested) throw new Error("取消自动任务");
    if (Date.now() - started >= LOOP_TIMEOUT_MS) {
        throw new Error("[MUSIC_FLOW_TIMEOUT] 乐流奔引120秒内未确认完成，停止当前步骤并交回委托重试");
    }
}

function freshSource(source) {
    const capturedAt = Number(source?.CapturedAt?.ToUnixTimeMilliseconds());
    const age = Date.now() - capturedAt;
    return source?.IsKnown === true && Number.isFinite(age) && age >= 0 && age <= FRAME_MAX_AGE_MS;
}

function readActiveChallenge(previous) {
    const capture = captureGameRegion();
    try {
        const source = capture.FrameStamp;
        if (!freshSource(source) || (previous && !source.IsAfter(previous))) return null;
        if (!capture.find(RO.inMainUI).isExist()) return null;
        const area = capture.DeriveCrop(ACTIVE_REGION.X, ACTIVE_REGION.Y, ACTIVE_REGION.Width, ACTIVE_REGION.Height);
        try {
            const results = area.findMulti(RecognitionObject.ocrThis);
            let remaining = false, interrupt = false;
            for (let i = 0; i < results.count; i++) {
                const text = String(results[i].text || "").replace(/\s/g, "");
                const match = /^剩余时间[:：]?(\d+)秒$/.exec(text);
                if (match && Number(match[1]) > 0) remaining = true;
                if (/^(?:P)?中断挑战$/.test(text)) interrupt = true;
            }
            if (!remaining || !interrupt) return null;
            const interactive = capture.find(RO.moonLightIcon).isExist();
            return freshSource(source) ? { source, interactive } : null;
        } finally { area.Dispose(); }
    } finally { capture.Dispose(); }
}

function angleDelta(current, previous) {
    return ((current - previous + 540) % 360 + 360) % 360 - 180;
}

function acquireMoonlight(camera, started) {
    if (camera.disabled || camera.moves >= CAMERA_DIRECTIONS.length) return;
    const observation = readActiveChallenge(camera.source);
    ensureWithinStep(started);
    if (!observation) return;
    const { source, interactive } = observation;
    if (interactive) {
        camera.disabled = true;
        return true;
    }
    const angle = Number(genshin.getCameraOrientation());
    ensureWithinStep(started);
    if (!freshSource(source)) return;
    if (!Number.isFinite(angle) || angle < 0 || angle > 360) { camera.disabled = true; return; }
    if (camera.initial == null) camera.initial = angle;
    if (camera.previous != null) camera.travel += Math.abs(angleDelta(angle, camera.previous));
    camera.previous = angle;
    camera.source = source;
    // Bound observed travel as well as dispatch count. Unexpected turn/drift retires acquisition instead of chasing it.
    if (camera.travel >= CAMERA_MAX_TRAVEL_DEGREES ||
        Math.abs(angleDelta(angle, camera.initial)) > CAMERA_MAX_OFFSET_DEGREES) {
        camera.disabled = true;
        return;
    }
    ensureWithinStep(started);
    moveMouseBy(CAMERA_STEP_X * CAMERA_DIRECTIONS[camera.moves++], 0);
}

function isCommissionCompleted() {
    try {
        const text = bvPageOcrRegionText(COMPLETION_REGION);
        if (text.includes("委托完成")) {
            log.info("识别到委托完成文本: {text}", text);
            return true;
        }
        return false;
    } catch (error) {
        rethrowIfCancellation(error);
        log.debug("乐流奔引委托完成 OCR 失败: {error}", error.message);
        return false;
    }
}

function readChallengeFailure() {
    try {
        // 失败提示不限定在完成提示的小区域；限频全屏读取，只接受明确提示。
        const results = bvPageOcrRegion();
        for (let i = 0; i < results.count; i++) {
            const text = String(results[i].text || "").replace(/\s/g, "");
            if (/^(挑战失败|挑战超时)[!！。]?$/.test(text)) return text;
        }
    } catch (error) {
        rethrowIfCancellation(error);
        log.debug("乐流奔引失败提示 OCR 不可用: {error}", error.message);
    }
    return null;
}

export default defineStep({
    type: "乐流奔引",
    category: "特定委托对策",
    dataSpec: { kind: "none" },
    run: async () => {
        const page = new BvPage();
        const started = Date.now();
        let nextFailureCheck = started;
        const camera = { moves: 0, travel: 0, initial: null, previous: null, source: null, disabled: false };

        log.info("开始执行乐流奔引步骤，循环检测月光图标");
        while (Date.now() - started < LOOP_TIMEOUT_MS) {
            ensureWithinStep(started);
            const completed = isCommissionCompleted();
            ensureWithinStep(started);
            if (completed) {
                return true;
            }

            if (Date.now() >= nextFailureCheck) {
                nextFailureCheck = Date.now() + FAILURE_CHECK_INTERVAL_MS;
                const failure = readChallengeFailure();
                if (failure) throw new Error(`[MUSIC_FLOW_FAILED] ${failure}，停止当前步骤并交回委托重试`);
            }

            let interactive = page.locator(RO.moonLightIcon).isExist();
            ensureWithinStep(started);
            if (!interactive) interactive = acquireMoonlight(camera, started) === true;
            ensureWithinStep(started);
            if (interactive) {
                camera.disabled = true;
                log.info("识别到月光图标，按 T 触发");
                keyPress("t");
                await sleep(2000);
            }

            await sleep(CHECK_INTERVAL_MS);
        }
        // registry.process 不消费 handler 的 false 返回值，因此必须抛错交回上层。
        throw new Error("[MUSIC_FLOW_TIMEOUT] 乐流奔引120秒内未确认完成，停止当前步骤并交回委托重试");
    },
});
