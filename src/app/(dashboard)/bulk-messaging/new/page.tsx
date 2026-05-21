"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import {
  Upload,
  ChevronRight,
  ChevronLeft,
  Download,
  CheckCircle2,
  AlertCircle,
  Send,
  RefreshCw,
  FileSpreadsheet,
  Megaphone,
} from "lucide-react";

interface ParsedSheet {
  columns: string[];
  rows: Array<Record<string, string>>;
  totalRows: number;
  truncated: boolean;
  format: "csv" | "xlsx";
}

interface CachedTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  bodyParamCount: number;
  bodyText: string | null;
  headerType: string | null;
}

interface VariableMapping {
  column: string | null;
  literal: string | null;
}

interface NumberOption {
  id: string;
  label: string;
  phoneNumberId: string;
  displayPhone: string;
  isDefault: boolean;
}

type Step = "upload" | "mapping" | "template" | "review";

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload sheet" },
  { key: "mapping", label: "Map columns" },
  { key: "template", label: "Choose template" },
  { key: "review", label: "Review & Send" },
];

export default function NewBulkCampaignPage() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("upload");
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [fileName, setFileName] = useState<string>("");

  const [phoneColumn, setPhoneColumn] = useState<string>("");
  const [nameColumn, setNameColumn] = useState<string>("");

  const [templates, setTemplates] = useState<CachedTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<CachedTemplate | null>(
    null
  );
  const [variableColumns, setVariableColumns] = useState<VariableMapping[]>([]);
  const [headerType, setHeaderType] = useState<"text" | "image" | null>(null);
  const [headerValue, setHeaderValue] = useState<string>("");
  const [headerKind, setHeaderKind] = useState<"url" | "id">("url");

  const [campaignName, setCampaignName] = useState<string>("");
  const [throttleMs, setThrottleMs] = useState<number>(200);
  const [maxAttempts, setMaxAttempts] = useState<number>(3);
  const [dedupePhones, setDedupePhones] = useState<boolean>(true);

  const [numbers, setNumbers] = useState<NumberOption[]>([]);
  const [selectedNumberId, setSelectedNumberId] = useState<string>("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = async () => {
    setTemplatesLoading(true);
    try {
      const data = await api.get<{
        templates: CachedTemplate[];
      }>("/whatsapp/templates/cached?status=APPROVED");
      setTemplates(data.templates);
    } catch (err) {
      console.error(err);
    } finally {
      setTemplatesLoading(false);
    }
  };

  const loadNumbers = async () => {
    try {
      const data = await api.get<{ numbers: NumberOption[] }>("/whatsapp/numbers");
      setNumbers(data.numbers ?? []);
    } catch {
      // Multi-number setup may not be configured; that's fine.
    }
  };

  // Load templates + WA numbers once. Templates feed the picker; numbers
  // feed the optional "send from" selector (multi-account support).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTemplates();
    void loadNumbers();
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setFileName(file.name);
    const form = new FormData();
    form.set("file", file);
    try {
      const res = await fetch("/api/bulk-messaging/parse", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Parse failed");
      }
      setSheet(data);
      // Best-effort auto-detection of the phone column so the operator
      // doesn't have to scroll. Looks for anything called phone / mobile /
      // number / tel.
      const phoneCol = data.columns.find((c: string) =>
        /^(phone|mobile|number|tel|whatsapp|wa)/i.test(c)
      );
      if (phoneCol) setPhoneColumn(phoneCol);
      const nameCol = data.columns.find((c: string) =>
        /^(name|customer|client|fullname|full[\s_-]?name)/i.test(c)
      );
      if (nameCol) setNameColumn(nameCol);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }, []);

  const onTemplateSelected = (t: CachedTemplate) => {
    setSelectedTemplate(t);
    // Default each variable slot to nothing — the operator picks per
    // template body param. Preserve any previous mapping if the same
    // template was re-selected.
    const next: VariableMapping[] = [];
    for (let i = 0; i < t.bodyParamCount; i++) {
      next.push(variableColumns[i] ?? { column: null, literal: null });
    }
    setVariableColumns(next);
    if (t.headerType === "TEXT") setHeaderType("text");
    else if (t.headerType === "IMAGE") setHeaderType("image");
    else setHeaderType(null);
  };

  // ----- Preview helpers (uses the FIRST row of the uploaded sheet) -----

  const previewRow = useMemo(() => {
    if (!sheet || sheet.rows.length === 0) return null;
    return sheet.rows[0];
  }, [sheet]);

  const renderPreview = useMemo(() => {
    if (!selectedTemplate?.bodyText) return null;
    if (!previewRow) return selectedTemplate.bodyText;
    return selectedTemplate.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
      const idx = parseInt(n, 10) - 1;
      const slot = variableColumns[idx];
      if (!slot) return `{{${n}}}`;
      if (slot.column) return previewRow[slot.column] ?? "";
      if (slot.literal) return slot.literal;
      return "";
    });
  }, [selectedTemplate, previewRow, variableColumns]);

  // ----- Step navigation guards -----

  const canGoFromUpload = sheet && sheet.rows.length > 0;
  const canGoFromMapping = phoneColumn !== "";
  const canGoFromTemplate = selectedTemplate !== null;

  const goNext = () => {
    if (step === "upload" && canGoFromUpload) setStep("mapping");
    else if (step === "mapping" && canGoFromMapping) setStep("template");
    else if (step === "template" && canGoFromTemplate) setStep("review");
  };

  const goBack = () => {
    if (step === "mapping") setStep("upload");
    else if (step === "template") setStep("mapping");
    else if (step === "review") setStep("template");
  };

  // ----- Send -----

  const submit = async () => {
    if (!sheet || !selectedTemplate || !phoneColumn) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: campaignName.trim() || `${selectedTemplate.name} • ${new Date().toLocaleString()}`,
        templateName: selectedTemplate.name,
        templateLanguage: selectedTemplate.language,
        bodyParamCount: selectedTemplate.bodyParamCount,
        headerType,
        headerValue: headerValue.trim() || null,
        headerKind: headerType === "image" ? headerKind : null,
        phoneNumberId: selectedNumberId || null,
        columnMapping: {
          phoneColumn,
          nameColumn: nameColumn || null,
          variableColumns,
        },
        rows: sheet.rows,
        throttleMs,
        maxAttempts,
        dedupePhones,
      };
      const data = await api.post<{ campaign: { id: string } }>(
        "/bulk-messaging/campaigns",
        payload
      );
      router.push(`/bulk-messaging/${data.campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create campaign");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Megaphone size={22} className="text-blue-600" />
          New Bulk Campaign
        </h1>
        <Link
          href="/bulk-messaging"
          className="text-sm text-gray-500 hover:text-gray-900"
        >
          ← Back to campaigns
        </Link>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {STEPS.map((s, i) => {
          const stepIndex = STEPS.findIndex((x) => x.key === step);
          const isCurrent = s.key === step;
          const isDone = i < stepIndex;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium border ${
                  isCurrent
                    ? "bg-blue-600 text-white border-blue-600"
                    : isDone
                    ? "bg-green-50 text-green-700 border-green-200"
                    : "bg-white text-gray-500 border-gray-200"
                }`}
              >
                <span
                  className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${
                    isCurrent
                      ? "bg-white text-blue-600"
                      : isDone
                      ? "bg-green-500 text-white"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {isDone ? <CheckCircle2 size={12} /> : i + 1}
                </span>
                {s.label}
              </div>
              {i < STEPS.length - 1 && (
                <ChevronRight size={14} className="text-gray-300" />
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {step === "upload" && (
        <UploadStep
          sheet={sheet}
          fileName={fileName}
          onFile={handleFile}
          onClear={() => {
            setSheet(null);
            setFileName("");
            setPhoneColumn("");
            setNameColumn("");
          }}
        />
      )}

      {step === "mapping" && sheet && (
        <MappingStep
          sheet={sheet}
          phoneColumn={phoneColumn}
          nameColumn={nameColumn}
          onPhoneColumnChange={setPhoneColumn}
          onNameColumnChange={setNameColumn}
        />
      )}

      {step === "template" && sheet && (
        <TemplateStep
          templates={templates}
          templatesLoading={templatesLoading}
          selectedTemplate={selectedTemplate}
          onSelect={onTemplateSelected}
          variableColumns={variableColumns}
          onVariableChange={setVariableColumns}
          sheetColumns={sheet.columns}
          headerType={headerType}
          headerValue={headerValue}
          onHeaderValueChange={setHeaderValue}
          headerKind={headerKind}
          onHeaderKindChange={setHeaderKind}
          renderPreview={renderPreview}
          onRefreshTemplates={loadTemplates}
        />
      )}

      {step === "review" && sheet && selectedTemplate && (
        <ReviewStep
          sheet={sheet}
          template={selectedTemplate}
          phoneColumn={phoneColumn}
          nameColumn={nameColumn}
          variableColumns={variableColumns}
          headerType={headerType}
          headerValue={headerValue}
          headerKind={headerKind}
          campaignName={campaignName}
          onCampaignNameChange={setCampaignName}
          throttleMs={throttleMs}
          onThrottleMsChange={setThrottleMs}
          maxAttempts={maxAttempts}
          onMaxAttemptsChange={setMaxAttempts}
          dedupePhones={dedupePhones}
          onDedupePhonesChange={setDedupePhones}
          numbers={numbers}
          selectedNumberId={selectedNumberId}
          onSelectedNumberIdChange={setSelectedNumberId}
        />
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={goBack}
          disabled={step === "upload"}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={14} />
          Back
        </button>
        {step !== "review" ? (
          <button
            type="button"
            onClick={goNext}
            disabled={
              (step === "upload" && !canGoFromUpload) ||
              (step === "mapping" && !canGoFromMapping) ||
              (step === "template" && !canGoFromTemplate)
            }
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next
            <ChevronRight size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-60 shadow-sm"
          >
            {submitting ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Send size={14} />
            )}
            {submitting ? "Sending…" : `Send to ${sheet?.totalRows ?? 0} recipients`}
          </button>
        )}
      </div>
    </div>
  );
}

// ============== STEP 1: Upload ==============

function UploadStep({
  sheet,
  fileName,
  onFile,
  onClear,
}: {
  sheet: ParsedSheet | null;
  fileName: string;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">
            Upload your recipients sheet
          </h2>
          <p className="text-sm text-gray-500">
            CSV or Excel (XLSX). First row should contain column headers
            (e.g. <code>phone</code>, <code>name</code>,{" "}
            <code>order_id</code>).
          </p>
        </div>
        <a
          href="/api/bulk-messaging/sample-template"
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 rounded-md bg-blue-50 hover:bg-blue-100"
        >
          <Download size={12} />
          Download sample CSV
        </a>
      </div>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={`block border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 hover:border-gray-400 bg-gray-50"
        }`}
      >
        <input
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
          }}
        />
        <Upload size={28} className="mx-auto text-gray-400 mb-2" />
        <p className="text-sm font-medium text-gray-700">
          Click to upload or drag and drop
        </p>
        <p className="text-xs text-gray-500 mt-1">CSV or XLSX, up to 10 MB</p>
      </label>

      {sheet && (
        <div className="mt-5 p-4 rounded-md bg-gray-50 border border-gray-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={16} className="text-green-600" />
              <span className="text-sm font-medium text-gray-900">
                {fileName || "Uploaded file"}
              </span>
              <span className="text-xs text-gray-500">
                ({sheet.totalRows} rows, {sheet.columns.length} columns)
              </span>
            </div>
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-gray-500 hover:text-red-600"
            >
              Clear
            </button>
          </div>
          {sheet.truncated && (
            <div className="mb-3 p-2 bg-orange-50 border border-orange-200 rounded text-xs text-orange-700">
              Only the first 10,000 rows were loaded. Trim your sheet or
              split into multiple campaigns to send more.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-white">
                <tr className="text-left text-gray-500 uppercase">
                  {sheet.columns.map((c) => (
                    <th key={c} className="px-2 py-1.5 border border-gray-200 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(0, 5).map((row, i) => (
                  <tr key={i}>
                    {sheet.columns.map((c) => (
                      <td
                        key={c}
                        className="px-2 py-1.5 border border-gray-200 text-gray-700 whitespace-nowrap max-w-xs overflow-hidden text-ellipsis"
                        title={row[c]}
                      >
                        {row[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== STEP 2: Map columns ==============

function MappingStep({
  sheet,
  phoneColumn,
  nameColumn,
  onPhoneColumnChange,
  onNameColumnChange,
}: {
  sheet: ParsedSheet;
  phoneColumn: string;
  nameColumn: string;
  onPhoneColumnChange: (v: string) => void;
  onNameColumnChange: (v: string) => void;
}) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">
        Tell us which column holds the phone number
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        We&apos;ll auto-normalize numbers to international format using your
        Settings → Default Country Code. Rows with an empty or unparseable
        phone are marked <strong>FAILED</strong> and skipped.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Phone number column <span className="text-red-500">*</span>
          </label>
          <select
            value={phoneColumn}
            onChange={(e) => onPhoneColumnChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— Select a column —</option>
            {sheet.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Customer name column{" "}
            <span className="text-xs text-gray-400">(optional, display only)</span>
          </label>
          <select
            value={nameColumn}
            onChange={(e) => onNameColumnChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— No name column —</option>
            {sheet.columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {phoneColumn && (
        <div className="border border-gray-200 rounded-md overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-600 border-b border-gray-200">
            Preview — first 5 rows
          </div>
          <table className="w-full text-xs">
            <thead className="bg-white">
              <tr className="text-left text-gray-500 uppercase">
                {nameColumn && (
                  <th className="px-3 py-1.5 border-r border-gray-200">
                    Name ({nameColumn})
                  </th>
                )}
                <th className="px-3 py-1.5 border-r border-gray-200">
                  Phone ({phoneColumn})
                </th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.slice(0, 5).map((row, i) => (
                <tr key={i} className="border-t border-gray-100">
                  {nameColumn && (
                    <td className="px-3 py-1.5 border-r border-gray-200 text-gray-700">
                      {row[nameColumn]}
                    </td>
                  )}
                  <td className="px-3 py-1.5 border-r border-gray-200 text-gray-700 font-mono">
                    {row[phoneColumn]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ============== STEP 3: Template ==============

function TemplateStep({
  templates,
  templatesLoading,
  selectedTemplate,
  onSelect,
  variableColumns,
  onVariableChange,
  sheetColumns,
  headerType,
  headerValue,
  onHeaderValueChange,
  headerKind,
  onHeaderKindChange,
  renderPreview,
  onRefreshTemplates,
}: {
  templates: CachedTemplate[];
  templatesLoading: boolean;
  selectedTemplate: CachedTemplate | null;
  onSelect: (t: CachedTemplate) => void;
  variableColumns: VariableMapping[];
  onVariableChange: (next: VariableMapping[]) => void;
  sheetColumns: string[];
  headerType: "text" | "image" | null;
  headerValue: string;
  onHeaderValueChange: (v: string) => void;
  headerKind: "url" | "id";
  onHeaderKindChange: (v: "url" | "id") => void;
  renderPreview: string | null;
  onRefreshTemplates: () => void;
}) {
  const updateVariable = (idx: number, patch: Partial<VariableMapping>) => {
    const next = variableColumns.map((v, i) =>
      i === idx ? { ...v, ...patch } : v
    );
    onVariableChange(next);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Choose a template
          </h2>
          <button
            type="button"
            onClick={onRefreshTemplates}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900"
          >
            <RefreshCw
              size={12}
              className={templatesLoading ? "animate-spin" : ""}
            />
            Refresh
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-3">
          Only <strong>APPROVED</strong> templates are listed. Sync from Meta
          via{" "}
          <Link href="/templates" className="text-blue-600 hover:underline">
            Templates → Sync now
          </Link>{" "}
          if a recently approved template is missing.
        </p>

        {templatesLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">
            Loading templates…
          </div>
        ) : templates.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500 border border-dashed border-gray-300 rounded">
            No approved templates cached locally yet.
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-auto border border-gray-200 rounded-md">
            {templates.map((t) => {
              const isSelected = selectedTemplate?.id === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelect(t)}
                  className={`block w-full text-left px-3 py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 ${
                    isSelected ? "bg-blue-50" : "bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-medium text-gray-900">
                      {t.name}
                    </span>
                    <span className="text-xs text-gray-500">
                      {t.language} · {t.bodyParamCount} var
                      {t.bodyParamCount === 1 ? "" : "s"}
                      {t.headerType ? ` · ${t.headerType} header` : ""}
                    </span>
                  </div>
                  {t.bodyText && (
                    <p className="text-xs text-gray-500 mt-1 line-clamp-2 whitespace-pre-wrap">
                      {t.bodyText}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {selectedTemplate && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              Map sheet columns to template variables
            </h3>
            {selectedTemplate.bodyParamCount === 0 ? (
              <p className="text-xs text-gray-500">
                This template has no body variables. Just click Next.
              </p>
            ) : (
              <div className="space-y-2">
                {Array.from({ length: selectedTemplate.bodyParamCount }).map(
                  (_, i) => {
                    const slot = variableColumns[i] ?? {
                      column: null,
                      literal: null,
                    };
                    return (
                      <div key={i} className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-2 text-xs font-mono text-gray-500">
                          {`{{${i + 1}}}`}
                        </div>
                        <div className="col-span-5">
                          <select
                            value={slot.column ?? ""}
                            onChange={(e) =>
                              updateVariable(i, {
                                column: e.target.value || null,
                                literal: e.target.value ? null : slot.literal,
                              })
                            }
                            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
                          >
                            <option value="">— Sheet column —</option>
                            {sheetColumns.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-5">
                          <input
                            type="text"
                            value={slot.literal ?? ""}
                            onChange={(e) =>
                              updateVariable(i, {
                                literal: e.target.value || null,
                                column: e.target.value ? null : slot.column,
                              })
                            }
                            placeholder="…or a literal default (used if column blank)"
                            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
                          />
                        </div>
                      </div>
                    );
                  }
                )}
                <p className="text-xs text-gray-400 mt-2">
                  Pick either a column or a literal per variable. If both are
                  empty, that slot is sent as an empty string.
                </p>
              </div>
            )}

            {headerType && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <h3 className="text-sm font-semibold text-gray-900 mb-2">
                  Header ({headerType.toUpperCase()})
                </h3>
                {headerType === "image" && (
                  <div className="flex items-center gap-2 mb-2 text-xs text-gray-500">
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        checked={headerKind === "url"}
                        onChange={() => onHeaderKindChange("url")}
                      />
                      Public URL
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        checked={headerKind === "id"}
                        onChange={() => onHeaderKindChange("id")}
                      />
                      Meta media ID
                    </label>
                  </div>
                )}
                <input
                  type="text"
                  value={headerValue}
                  onChange={(e) => onHeaderValueChange(e.target.value)}
                  placeholder={
                    headerType === "image"
                      ? headerKind === "url"
                        ? "https://example.com/banner.jpg"
                        : "1234567890123456"
                      : "Header text"
                  }
                  className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm bg-white"
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="lg:col-span-2">
        <div className="sticky top-4 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">
            Preview (first row)
          </h3>
          {renderPreview ? (
            <div className="p-3 rounded-md bg-green-50 border border-green-200 text-sm text-gray-900 whitespace-pre-wrap">
              {renderPreview}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Select a template to see how the first row will render.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============== STEP 4: Review & Send ==============

function ReviewStep({
  sheet,
  template,
  phoneColumn,
  nameColumn,
  variableColumns,
  headerType,
  headerValue,
  headerKind,
  campaignName,
  onCampaignNameChange,
  throttleMs,
  onThrottleMsChange,
  maxAttempts,
  onMaxAttemptsChange,
  dedupePhones,
  onDedupePhonesChange,
  numbers,
  selectedNumberId,
  onSelectedNumberIdChange,
}: {
  sheet: ParsedSheet;
  template: CachedTemplate;
  phoneColumn: string;
  nameColumn: string;
  variableColumns: VariableMapping[];
  headerType: "text" | "image" | null;
  headerValue: string;
  headerKind: "url" | "id";
  campaignName: string;
  onCampaignNameChange: (v: string) => void;
  throttleMs: number;
  onThrottleMsChange: (v: number) => void;
  maxAttempts: number;
  onMaxAttemptsChange: (v: number) => void;
  dedupePhones: boolean;
  onDedupePhonesChange: (v: boolean) => void;
  numbers: NumberOption[];
  selectedNumberId: string;
  onSelectedNumberIdChange: (v: string) => void;
}) {
  // Cheap client-side validation summary for the review screen.
  const summary = useMemo(() => {
    let validPhones = 0;
    let invalidPhones = 0;
    const seen = new Set<string>();
    let duplicates = 0;
    for (const row of sheet.rows) {
      const raw = (row[phoneColumn] ?? "").trim();
      if (!raw) {
        invalidPhones++;
        continue;
      }
      const digits = raw.replace(/[^0-9]/g, "");
      if (digits.length < 8) {
        invalidPhones++;
        continue;
      }
      if (seen.has(digits)) duplicates++;
      seen.add(digits);
      validPhones++;
    }
    return { validPhones, invalidPhones, duplicates };
  }, [sheet, phoneColumn]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Review and configure send
        </h2>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Campaign name
            </label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => onCampaignNameChange(e.target.value)}
              placeholder={`${template.name} • ${new Date().toLocaleString()}`}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>

          {numbers.length > 1 && (
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Send from
              </label>
              <select
                value={selectedNumberId}
                onChange={(e) => onSelectedNumberIdChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
              >
                <option value="">Default WhatsApp number</option>
                {numbers.map((n) => (
                  <option key={n.id} value={n.phoneNumberId}>
                    {n.label} ({n.displayPhone})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Delay between sends (ms)
            </label>
            <input
              type="number"
              min={0}
              max={5000}
              value={throttleMs}
              onChange={(e) => onThrottleMsChange(parseInt(e.target.value, 10) || 0)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              200ms is safe for Meta&apos;s rate limits.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Retries on failure
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxAttempts}
              onChange={(e) =>
                onMaxAttemptsChange(parseInt(e.target.value, 10) || 1)
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">
              Transient 5xx and network errors will retry with backoff.
            </p>
          </div>

          <div className="col-span-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={dedupePhones}
                onChange={(e) => onDedupePhonesChange(e.target.checked)}
              />
              Skip duplicate phone numbers within this upload
            </label>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="p-3 rounded-md bg-green-50 border border-green-200 text-center">
            <div className="text-lg font-bold text-green-700">{summary.validPhones}</div>
            <div className="text-xs text-green-600">Valid phones</div>
          </div>
          <div className="p-3 rounded-md bg-red-50 border border-red-200 text-center">
            <div className="text-lg font-bold text-red-700">{summary.invalidPhones}</div>
            <div className="text-xs text-red-600">Invalid / empty</div>
          </div>
          <div className="p-3 rounded-md bg-orange-50 border border-orange-200 text-center">
            <div className="text-lg font-bold text-orange-700">{summary.duplicates}</div>
            <div className="text-xs text-orange-600">Duplicates</div>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          Total rows in sheet: <strong>{sheet.totalRows}</strong>. Invalid /
          empty phones will be marked <strong>FAILED</strong>; duplicates
          {dedupePhones ? " marked SKIPPED" : " will be sent again"}.
        </p>
      </div>

      <div className="lg:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Summary</h3>
        <dl className="space-y-2 text-sm text-gray-700">
          <div className="flex justify-between border-b border-gray-100 pb-1">
            <dt className="text-gray-500">Template</dt>
            <dd className="font-mono text-xs">{template.name}</dd>
          </div>
          <div className="flex justify-between border-b border-gray-100 pb-1">
            <dt className="text-gray-500">Language</dt>
            <dd>{template.language}</dd>
          </div>
          <div className="flex justify-between border-b border-gray-100 pb-1">
            <dt className="text-gray-500">Phone column</dt>
            <dd className="font-mono text-xs">{phoneColumn}</dd>
          </div>
          {nameColumn && (
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <dt className="text-gray-500">Name column</dt>
              <dd className="font-mono text-xs">{nameColumn}</dd>
            </div>
          )}
          <div className="flex justify-between border-b border-gray-100 pb-1">
            <dt className="text-gray-500">Body variables</dt>
            <dd>{variableColumns.length}</dd>
          </div>
          {headerType && (
            <div className="flex justify-between border-b border-gray-100 pb-1">
              <dt className="text-gray-500">Header</dt>
              <dd className="text-xs">
                {headerType.toUpperCase()}
                {headerType === "image" ? ` (${headerKind})` : ""}
                {headerValue ? " — set" : " — empty"}
              </dd>
            </div>
          )}
          <div className="flex justify-between pt-1">
            <dt className="text-gray-500">Recipients</dt>
            <dd className="font-semibold">{sheet.totalRows}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
