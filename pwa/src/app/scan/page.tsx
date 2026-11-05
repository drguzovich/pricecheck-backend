"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { ScanQueue, type ScanQueueHandle } from "@/components/scan-queue";
import { normalizeScanBarcode } from "@/lib/scan-queue";
import "@/styles/scan-queue.css";

type DetectorResult = { rawValue?: string };
type DetectorInstance = { detect: (source: HTMLVideoElement) => Promise<DetectorResult[]> };
type ScanMode = "queue" | "single";

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => DetectorInstance;
  }
}

export default function ScanPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const queueRef = useRef<ScanQueueHandle>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null);
  const frameRef = useRef<number | null>(null);
  const scannerStartingRef = useRef(false);
  const navigatingRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const modeRef = useRef<ScanMode>("queue");
  const lastCameraRead = useRef({ barcode: "", at: 0 });
  const [mode, setMode] = useState<ScanMode>("queue");
  const [barcode, setBarcode] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "ready" | "unavailable" | "denied">("starting");
  const [message, setMessage] = useState("Starting your rear camera…");
  const [entryError, setEntryError] = useState("");

  const stopScanner = useCallback(() => {
    generationRef.current += 1;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    zxingControlsRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    zxingControlsRef.current = null;
    streamRef.current = null;
    scannerStartingRef.current = false;
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.srcObject = null; }
  }, []);

  const submitBarcode = useCallback((value: string, source: "camera" | "manual") => {
    const normalized = normalizeScanBarcode(value);
    if (!normalized) {
      if (source === "manual") setEntryError("Enter an 8 to 14 digit retail barcode. Spaces and hyphens are allowed.");
      return;
    }
    setEntryError("");
    if (source === "camera") {
      const now = Date.now();
      if (lastCameraRead.current.barcode === normalized && now - lastCameraRead.current.at < 2000) return;
      lastCameraRead.current = { barcode: normalized, at: now };
    }
    if (modeRef.current === "single") {
      if (navigatingRef.current) return;
      navigatingRef.current = true;
      stopScanner();
      router.push(`/result?barcode=${encodeURIComponent(normalized)}`);
      return;
    }
    const outcome = queueRef.current?.add(normalized, source);
    if (outcome === "added") {
      setMessage(`Barcode ${normalized} added. Move to the next product, or enter another barcode below.`);
      if (source === "manual") setBarcode("");
    } else if (outcome === "full") {
      setMessage("Your queue has 100 products. Remove a product or clear the queue to keep scanning.");
    }
  }, [router, stopScanner]);

  const startScanner = useCallback(async () => {
    if (scannerStartingRef.current || streamRef.current) return;
    scannerStartingRef.current = true;
    navigatingRef.current = false;
    lastCameraRead.current = { barcode: "", at: 0 };
    const generation = ++generationRef.current;
    const active = () => mountedRef.current && generationRef.current === generation && !navigatingRef.current;
    setStatus("starting");
    setMessage("Starting your rear camera…");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        setMessage("Camera access is not available in this browser. Enter barcode digits below instead.");
        scannerStartingRef.current = false;
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      if (!active()) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview is unavailable");
      video.srcObject = stream;
      await video.play();
      if (!active()) return;
      scannerStartingRef.current = false;
      setStatus("ready");
      setMessage("Keep only the barcode lines in the green band. In continuous mode, move to the next product after it is added.");

      const startFallback = async () => {
        const { BrowserMultiFormatOneDReader } = await import("@zxing/browser");
        if (!active()) return;
        const reader = new BrowserMultiFormatOneDReader(undefined, { delayBetweenScanAttempts: 100, delayBetweenScanSuccess: 500, tryPlayVideoTimeout: 5000 });
        // Reuse the rear-camera stream. Opening a second stream can fail on mobile Safari.
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (active() && result?.getText()) submitBarcode(result.getText(), "camera");
        });
        if (!active()) { controls.stop(); return; }
        zxingControlsRef.current = controls;
      };
      let detector: DetectorInstance | null = null;
      if (window.BarcodeDetector) {
        try { detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"] }); } catch { /* Unsupported native formats use ZXing. */ }
      }
      if (!detector) { await startFallback(); return; }
      const nativeDetector = detector;
      let failures = 0;
      let lastDetectionAt = 0;
      const detectFrame = async (frameTime: number) => {
        if (!active() || !streamRef.current) return;
        if (frameTime - lastDetectionAt < 180) { frameRef.current = requestAnimationFrame(detectFrame); return; }
        lastDetectionAt = frameTime;
        try {
          const results = await nativeDetector.detect(video);
          if (!active()) return;
          failures = 0;
          // Different decoded barcode values are products. Retailer responses never enter this path.
          for (const result of results.slice(0, 4)) {
            if (!active()) break;
            if (result.rawValue) submitBarcode(result.rawValue, "camera");
          }
        } catch {
          failures += 1;
          if (!active()) return;
          if (failures >= 3) {
            try { await startFallback(); } catch {
              if (active()) { stopScanner(); setStatus("unavailable"); setMessage("Barcode detection is unavailable. Enter barcode digits below, or try the camera again."); }
            }
            return;
          }
        }
        if (active()) frameRef.current = requestAnimationFrame(detectFrame);
      };
      frameRef.current = requestAnimationFrame(detectFrame);
    } catch (error) {
      if (!active()) return;
      stopScanner();
      setStatus("denied");
      setMessage(error instanceof Error && error.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser settings, or enter barcode digits below." : "We could not start the camera. Try again or enter barcode digits below.");
    }
  }, [stopScanner, submitBarcode]);

  useEffect(() => {
    mountedRef.current = true;
    void startScanner();
    const leave = () => { stopScanner(); if (mountedRef.current) { setStatus("idle"); setMessage("Camera paused. Restart it when you are ready, or enter barcode digits below."); } };
    const hide = () => { if (document.visibilityState === "hidden") leave(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    return () => { mountedRef.current = false; window.removeEventListener("pagehide", leave); document.removeEventListener("visibilitychange", hide); stopScanner(); };
  }, [startScanner, stopScanner]);

  const submitManual = (event: FormEvent) => { event.preventDefault(); submitBarcode(barcode, "manual"); };
  const chooseMode = (next: ScanMode) => {
    modeRef.current = next;
    setMode(next);
    lastCameraRead.current = { barcode: "", at: 0 };
    setEntryError("");
    setMessage(next === "queue" ? "Continuous mode adds unique products to your queue. Your camera stays open until you pause it or leave." : "Single-product mode opens the next scanned barcode directly in its comparison page.");
  };

  return <main className="app-shell"><SiteHeader /><section className="scanner-page trolleywise-scanner">
    <div className="scanner-copy"><span className="eyebrow">Barcode scanner</span><h1>Scan your everyday shop.</h1><p role="status">{message}</p></div>
    <div className="scan-mode-control" role="group" aria-label="Scanning mode"><button type="button" aria-pressed={mode === "queue"} onClick={() => chooseMode("queue")}>Continuous queue</button><button type="button" aria-pressed={mode === "single"} onClick={() => chooseMode("single")}>One product</button></div>
    <div className="scanner-frame-wrap"><video ref={videoRef} className="scanner-video" muted playsInline aria-label="Rear camera barcode preview" /><div className="scanner-frame" aria-hidden="true"><i /><i /><i /><i /><span>Keep barcode lines inside this band</span></div>{status !== "ready" && <div className="camera-placeholder"><span aria-hidden="true">▣</span><p>{status === "starting" ? "Opening camera…" : "Camera preview"}</p></div>}</div>
    <p className="scanner-tip"><strong>Tip:</strong> Fill the green band with only the barcode. Adjust the distance until the lines are in focus. For bottles, rotate the label until the barcode looks flat and avoid glare.</p>
    <div className="scanner-actions">{(status === "ready" || status === "starting") && <button className="button button-secondary" type="button" onClick={() => { stopScanner(); setStatus("idle"); setMessage("Camera paused. You can enter barcode digits or restart the camera."); }}>Pause camera</button>}{(status === "idle" || status === "denied" || status === "unavailable") && <button className="button button-primary" type="button" onClick={() => void startScanner()}>Try camera again</button>}</div>
    <form className="manual-entry" onSubmit={submitManual}><label htmlFor="barcode">Or enter the barcode digits</label><div><input id="barcode" inputMode="numeric" autoComplete="off" value={barcode} onChange={(event) => setBarcode(event.target.value)} placeholder="e.g. 6001069206154" maxLength={32} aria-invalid={Boolean(entryError)} aria-describedby={entryError ? "barcode-error" : undefined} /><button className="button button-primary" type="submit">{mode === "queue" ? "Add to queue" : "Compare product"}</button></div>{entryError && <p id="barcode-error" className="scan-queue-error" role="alert">{entryError}</p>}</form>
    <ScanQueue ref={queueRef} />
  </section></main>;
}
