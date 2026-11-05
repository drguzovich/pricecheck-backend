"use client";

import { useEffect, useRef, useState } from "react";

const labelFields = [
  ["energyKJ", "Energy", "kJ"], ["energyKcal", "Energy", "kcal"],
  ["fat", "Fat", "g"], ["saturatedFat", "Saturated fat", "g"],
  ["carbohydrate", "Carbohydrate", "g"], ["sugar", "Sugar", "g"],
  ["protein", "Protein", "g"], ["fibre", "Fibre", "g"],
  ["salt", "Salt", "g"], ["sodium", "Sodium", "g"],
] as const;
type LabelKey = typeof labelFields[number][0];
type ConfirmedLabel = {
  version: 1; barcode: string; source: "user-provided"; confirmedAt: string;
  basis: "per100g"; ingredients: string; nutrition: Record<LabelKey, number | null>;
};
const storageKey = (barcode: string) => `trolleywise-label:${barcode}`;
const emptyFields = () => Object.fromEntries(labelFields.map(([key]) => [key, ""])) as Record<LabelKey, string>;

function validRecord(value: unknown, barcode: string): value is ConfirmedLabel {
  if (!value || typeof value !== "object") return false;
  const record = value as ConfirmedLabel;
  return record.version === 1 && record.barcode === barcode && record.source === "user-provided"
    && record.basis === "per100g" && typeof record.ingredients === "string"
    && typeof record.confirmedAt === "string" && Number.isFinite(new Date(record.confirmedAt).getTime())
    && !!record.nutrition && labelFields.every(([key]) => record.nutrition[key] === null
      || (typeof record.nutrition[key] === "number" && Number.isFinite(record.nutrition[key]) && (record.nutrition[key] as number) >= 0));
}

export function LabelDataInput({ barcode }: { barcode: string }) {
  const [fields, setFields] = useState<Record<LabelKey, string>>(emptyFields);
  const [ingredients, setIngredients] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState<ConfirmedLabel | null>(null);
  const [message, setMessage] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const record: unknown = JSON.parse(window.localStorage.getItem(storageKey(barcode)) || "null");
      if (!validRecord(record, barcode)) return;
      setSaved(record);
      setIngredients(record.ingredients);
      setFields(Object.fromEntries(labelFields.map(([key]) => [key, record.nutrition[key]?.toString() ?? ""])) as Record<LabelKey, string>);
    } catch { /* Label notes are optional and never sent to a server. */ }
  }, [barcode]);

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  function saveLabel(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed) { setMessage("Confirm that you checked these entries against the physical label."); return; }
    const nutrition = {} as Record<LabelKey, number | null>;
    for (const [key, label] of labelFields) {
      const text = fields[key].trim();
      if (text && !/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) { setMessage(`Enter a decimal number for ${label}, or leave it blank.`); return; }
      const value = text ? Number(text.replace(",", ".")) : null;
      if (value !== null && (!Number.isFinite(value) || value < 0)) { setMessage(`Enter a non-negative number for ${label}, or leave it blank.`); return; }
      nutrition[key] = value;
    }
    if (!ingredients.trim() && labelFields.every(([key]) => nutrition[key] === null)) { setMessage("Enter at least one label field. A photo alone does not supply confirmed data."); return; }
    const record: ConfirmedLabel = { version: 1, barcode, source: "user-provided", confirmedAt: new Date().toISOString(), basis: "per100g", ingredients: ingredients.trim(), nutrition };
    setSaved(record);
    try {
      window.localStorage.setItem(storageKey(barcode), JSON.stringify(record));
      setMessage("Your confirmed label notes are saved on this device only. They are not verified by Open Food Facts.");
    } catch {
      setMessage("Browser storage is unavailable. These user-provided notes will remain only in this open page.");
    }
  }

  function clearLabel() {
    try { window.localStorage.removeItem(storageKey(barcode)); }
    catch { setMessage("Browser storage could not be cleared. Clear this site's storage in your browser to remove saved notes."); return; }
    setSaved(null); setFields(emptyFields()); setIngredients(""); setConfirmed(false);
    setPhotoUrl(null); if (fileInput.current) fileInput.current.value = "";
    setMessage("Your label notes and photo preview have been cleared from this page and device storage.");
  }

  return (
    <div className="health-label-input">
      {saved && <div className="health-user-record"><h3>Your label notes</h3><p className="health-user-source">User-provided, confirmed by you. Not Open Food Facts data.</p><p>Confirmed: <time dateTime={saved.confirmedAt}>{new Date(saved.confirmedAt).toLocaleString()}</time></p>
        {saved.ingredients && <p className="health-ingredient-text">Ingredients you entered: {saved.ingredients}</p>}
        <dl className="health-user-nutrients">{labelFields.filter(([key]) => saved.nutrition[key] !== null).map(([key, label, unit]) => <div key={key}><dt>{label} ({unit}) per 100g</dt><dd>{saved.nutrition[key]} {unit}</dd></div>)}</dl>
        <p>No Clean Score is calculated from your notes. They do not establish verified source coverage or allergy safety.</p>
        <button type="button" className="button button-secondary" onClick={clearLabel}>Delete my label notes</button>
      </div>}
      <details className="health-label-details"><summary>{saved ? "Edit your on-device label notes" : "Missing source data? Add your own label notes"}</summary>
        <p>Copy the physical label yourself and confirm each entry. Notes stay on this device and are visibly user-provided. They never replace the Open Food Facts record or its score.</p>
        <form className="health-label-form" onSubmit={saveLabel}>
          <label className="health-label-photo">Optional label photo for your reference<input ref={fileInput} type="file" accept="image/*" onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) { setPhotoUrl(null); return; }
            if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) { setPhotoUrl(null); setMessage("Choose an image no larger than 10 MB."); event.target.value = ""; return; }
            setPhotoUrl(URL.createObjectURL(file)); setMessage("Photo preview stays in this open page. Nothing is uploaded or automatically read.");
          }} /><small>Preview only. No OCR, external upload or saved image.</small></label>
          {photoUrl && <div className="health-photo-preview">
            {/* Local object URLs are intentionally not uploaded or optimized by an image server. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl} alt="Your local product-label reference photo" />
            <button type="button" className="button button-secondary" onClick={() => { setPhotoUrl(null); if (fileInput.current) fileInput.current.value = ""; }}>Remove photo preview</button>
          </div>}
          <label>Ingredients as printed<textarea value={ingredients} maxLength={10000} rows={4} onChange={(event) => { setIngredients(event.target.value); setConfirmed(false); }} /></label>
          <fieldset><legend>Amounts per 100g, not per serving</legend><p>Leave unknown fields blank. Enter only fields explicitly given per 100g on your label. If the label uses 100ml, do not copy it into these fields.</p><div className="health-label-grid">{labelFields.map(([key, label, unit]) => <label key={key}>{label} ({unit})<input type="text" inputMode="decimal" maxLength={20} value={fields[key]} onChange={(event) => { setFields((previous) => ({ ...previous, [key]: event.target.value })); setConfirmed(false); }} /></label>)}</div></fieldset>
          <label className="health-label-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I checked the entered text, amounts, units and per100g basis against the physical label. These are my unverified notes, not Open Food Facts data.</span></label>
          <button type="submit" className="button button-primary" disabled={!confirmed}>Save confirmed notes on this device</button>
        </form>
      </details>
      {message && <p className="health-label-message" role="status">{message}</p>}
    </div>
  );
}
