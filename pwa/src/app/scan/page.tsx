"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SiteHeader } from "@/components/site-header";

type DetectorResult = { rawValue?: string };
type DetectorInstance = { detect: (source: HTMLVideoElement) => Promise<DetectorResult[]> };

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => DetectorInstance;
  }
}

export default function ScanPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null);
  const frameRef = useRef<number | null>(null);
  const scannerStartingRef = useRef(false);
  const navigatingRef = useRef(false);
  const [barcode, setBarcode] = useState("");
  const [status, setStatus] = useState<"idle" | "starting" | "ready" | "unavailable" | "denied">("starting");
  const [message, setMessage] = useState("Starting your rear camera…");

  const stopScanner = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    zxingControlsRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    frameRef.current = null;
    zxingControlsRef.current = null;
    streamRef.current = null;
    scannerStartingRef.current = false;
  }, []);

  const goToResult = useCallback((value: string) => {
    const normalized = value.replace(/\D/g, "");
    if (!/^\d{8,14}$/.test(normalized)) {
      setMessage("That does not look like a retail barcode. Try again or enter the digits manually.");
      return;
    }
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    stopScanner();
    router.push(`/result?barcode=${normalized}`);
  }, [router, stopScanner]);

  const startScanner = useCallback(async () => {
    if (scannerStartingRef.current || streamRef.current) return;
    scannerStartingRef.current = true;
    navigatingRef.current = false;
    setStatus("starting");
    setMessage("Starting your rear camera…");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        setMessage("Camera access is not available in this browser. Enter the barcode below instead.");
        scannerStartingRef.current = false;
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview is unavailable");

      video.srcObject = stream;
      await video.play();
      setStatus("ready");
      setMessage("Keep only the black barcode lines in the green band. For bottles, rotate until the label looks flat and avoid glare.");

      if (window.BarcodeDetector) {
        const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"] });
        const detectFrame = async () => {
          if (!videoRef.current || !streamRef.current || navigatingRef.current) return;
          try {
            const results = await detector.detect(videoRef.current);
            if (results[0]?.rawValue) {
              goToResult(results[0].rawValue);
              return;
            }
          } catch {
            // Continue scanning. Manual entry remains available if browser detection cannot read this barcode.
          }
          frameRef.current = requestAnimationFrame(detectFrame);
        };
        frameRef.current = requestAnimationFrame(detectFrame);
      } else {
        const { BrowserMultiFormatOneDReader } = await import("@zxing/browser");
        // Grocery barcodes are one-dimensional formats. Restricting the fallback reader
        // avoids spending time trying to decode QR and 2D formats on mobile Safari.
        const reader = new BrowserMultiFormatOneDReader(undefined, {
          delayBetweenScanAttempts: 75,
          delayBetweenScanSuccess: 500,
          tryPlayVideoTimeout: 5000,
        });
        zxingControlsRef.current = await reader.decodeFromVideoDevice(undefined, video, (result) => {
          if (result?.getText()) goToResult(result.getText());
        });
      }
    } catch (error) {
      stopScanner();
      setStatus("denied");
      setMessage(error instanceof Error && error.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access in Safari settings, or enter the barcode below."
        : "We could not start the camera. Try again or enter the barcode below.");
    }
  }, [goToResult, stopScanner]);

  useEffect(() => {
    startScanner();
    return stopScanner;
  }, [startScanner, stopScanner]);

  const submitManual = (event: FormEvent) => {
    event.preventDefault();
    goToResult(barcode);
  };

  const pauseCamera = () => {
    stopScanner();
    setStatus("idle");
    setMessage("Camera paused. You can enter the barcode manually or restart the camera.");
  };

  return (
    <main className="app-shell">
      <SiteHeader />
      <section className="scanner-page">
        <div className="scanner-copy">
          <span className="eyebrow">Barcode scanner</span>
          <h1>Scan a grocery product.</h1>
          <p>{message}</p>
        </div>
        <div className="scanner-frame-wrap">
          <video ref={videoRef} className="scanner-video" muted playsInline />
          <div className="scanner-frame" aria-hidden="true"><i /><i /><i /><i /><span>Keep barcode lines inside this band</span></div>
          {status !== "ready" && <div className="camera-placeholder"><span>▣</span><p>{status === "starting" ? "Opening camera…" : "Camera preview"}</p></div>}
        </div>
        <p className="scanner-tip"><strong>Tip:</strong> Do not match the entire product to the frame. Fill the green band with only the barcode, then adjust distance until the lines are in focus. For curved bottles, turn the bottle until the barcode appears flat to the camera.</p>
        <div className="scanner-actions">
          {status === "ready" && <button className="button button-secondary" onClick={pauseCamera}>Pause camera</button>}
          {(status === "idle" || status === "denied" || status === "unavailable") && <button className="button button-primary" onClick={startScanner}>Try camera again</button>}
        </div>
        <form className="manual-entry" onSubmit={submitManual}>
          <label htmlFor="barcode">Or enter the barcode digits</label>
          <div><input id="barcode" inputMode="numeric" value={barcode} onChange={(event) => setBarcode(event.target.value)} placeholder="e.g. 6001069206154" /><button className="button button-primary" type="submit">Compare</button></div>
        </form>
      </section>
    </main>
  );
}
