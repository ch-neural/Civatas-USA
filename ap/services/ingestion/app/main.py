"""Layer 1: Data Ingestion Service.

Parses user-uploaded statistical files (CSV / JSON / Excel)
and normalizes them into the internal ProjectConfig format.
"""
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import io
import fitz
import docx
import pandas as pd
from odf.opendocument import load as odf_load
from odf import teletype, text as odf_text

from .parser import parse_upload
from .repair import try_repair_content, try_fetch_from_gov_api
from .validator import validate_config

import re as _re


def _strip_rtf(raw: bytes) -> str:
    """Extract plain text from RTF content. Handles Unicode escapes."""
    # Try to decode as ASCII first (RTF is ASCII with Unicode escapes)
    try:
        rtf = raw.decode("ascii", errors="ignore")
    except Exception:
        rtf = raw.decode("utf-8", errors="ignore")

    out: list[str] = []
    i = 0
    depth = 0
    skip_groups = {"fonttbl", "colortbl", "expandedcolortbl", "stylesheet", "info", "pict"}
    skip_depth = -1

    while i < len(rtf):
        c = rtf[i]

        if c == "{":
            depth += 1
            # Check if this group should be skipped
            rest = rtf[i+1:i+30]
            for sg in skip_groups:
                if rest.lstrip("\\*").startswith(sg):
                    skip_depth = depth
                    break
            i += 1
            continue

        if c == "}":
            if depth == skip_depth:
                skip_depth = -1
            depth -= 1
            i += 1
            continue

        if skip_depth > 0:
            i += 1
            continue

        if c == "\\":
            i += 1
            if i >= len(rtf):
                break

            nc = rtf[i]

            # Unicode escape: \uN followed by a replacement char
            if nc == "u" and i + 1 < len(rtf):
                m = _re.match(r"u(-?\d+)", rtf[i:])
                if m:
                    code = int(m.group(1))
                    if code < 0:
                        code += 65536
                    out.append(chr(code))
                    i += len(m.group(0))
                    # Skip the replacement character(s) after \uN
                    # Usually one char, but \ucN can specify count
                    if i < len(rtf) and rtf[i] not in ("\\", "{", "}"):
                        i += 1
                    continue

            # Hex escape: \'XX
            if nc == "'":
                hex_str = rtf[i+1:i+3]
                if len(hex_str) == 2:
                    try:
                        out.append(bytes.fromhex(hex_str).decode("big5", errors="ignore"))
                    except Exception:
                        pass
                i += 3
                continue

            # Control words
            m = _re.match(r"([a-z]+)(-?\d*)\s?", rtf[i:])
            if m:
                word = m.group(1)
                i += len(m.group(0))
                if word == "par" or word == "line":
                    out.append("\n")
                elif word == "tab":
                    out.append("\t")
                elif word in ("uc", "pard", "plain", "cf", "fs", "b", "i"):
                    pass  # formatting — skip
                continue
            else:
                # Special chars like \\ \{ \}
                if nc in ("\\", "{", "}"):
                    out.append(nc)
                elif nc == "\n" or nc == "\r":
                    pass  # line continuation
                i += 1
                continue

        # Regular character
        if c not in ("\r", "\n"):
            out.append(c)
        i += 1

    text = "".join(out)
    # Clean up excessive whitespace
    text = _re.sub(r"\n{3,}", "\n\n", text)
    text = _re.sub(r"[ \t]+", " ", text)
    return text.strip()

app = FastAPI(title="Civatas · Ingestion", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "ingestion"}


@app.post("/parse")
async def parse(file: UploadFile = File(...)):
    """Parse an uploaded statistics file into ProjectConfig."""
    content = await file.read()
    fname = file.filename or "unknown"

    if not content or len(content) < 2:
        return JSONResponse(
            status_code=422,
            content={"error": "檔案為空或內容不足，請確認檔案是否完整。"},
        )

    original_err = None
    # --- Attempt 1: parse as-is ---
    try:
        config = parse_upload(fname, content)
        return config.model_dump()
    except Exception as e:
        original_err = e  # proceed to repair

    # --- Attempt 2: try content repair (encoding, BOM, JSON syntax) ---
    repaired = try_repair_content(fname, content)
    if repaired:
        try:
            config = parse_upload(fname, repaired)
            result = config.model_dump()
            result["_repaired"] = True
            result["_repair_note"] = "已自動修復檔案內容（編碼/格式問題）"
            return result
        except Exception:
            pass

    # --- Attempt 3: fallback to government API ---
    fetched = try_fetch_from_gov_api(fname)
    if fetched:
        try:
            config = parse_upload(fname, fetched)
            result = config.model_dump()
            result["_repaired"] = True
            result["_repair_note"] = "原始檔案損壞，已自動從政府開放資料 API 重新取得最新資料"
            return result
        except Exception as e:
            return JSONResponse(
                status_code=422,
                content={"error": f"已嘗試從政府 API 取得資料但解析失敗：{e}"},
            )

    # --- All repair attempts failed ---
    return JSONResponse(
        status_code=422,
        content={"error": f"解析失敗：{original_err}\n\n已嘗試自動修復但未成功。請確認檔案內容是否完整。"},
    )


@app.post("/validate")
async def validate(file: UploadFile = File(...)):
    """Parse and validate an uploaded statistics file."""
    content = await file.read()
    try:
        config = parse_upload(file.filename or "unknown", content)
    except Exception as e:
        return JSONResponse(
            status_code=422,
            content={"error": f"解析失敗：{e}"},
        )
    report = validate_config(config)
    return report


@app.post("/extract-text")
async def extract_text(file: UploadFile = File(...)):
    """Extract raw text from various file formats (PDF, DOCX, XLSX, CSV, TXT)."""
    content = await file.read()
    fname = (file.filename or "unknown").lower()
    
    if not content:
        return JSONResponse(status_code=422, content={"error": "檔案為空"})

    try:
        text = ""
        # 1. PDF extraction
        if fname.endswith(".pdf") or file.content_type == "application/pdf":
            doc = fitz.open(stream=content, filetype="pdf")
            for page in doc:
                text += page.get_text() + "\n\n"
            doc.close()
            
        # 2. Word (DOCX) extraction
        elif fname.endswith(".docx") or "wordprocessingml" in file.content_type:
            doc = docx.Document(io.BytesIO(content))
            text = "\n".join([p.text for p in doc.paragraphs])
            
        # 3. ODT extraction
        elif fname.endswith(".odt") or "opendocument.text" in file.content_type:
            doc = odf_load(io.BytesIO(content))
            paragraphs = doc.getElementsByType(odf_text.P)
            text = "\n".join([teletype.extractText(p) for p in paragraphs])
            
        # 4. Excel extraction
        elif fname.endswith((".xlsx", ".xls")) or "spreadsheet" in file.content_type:
            try:
                try:
                    df_dict = pd.read_excel(io.BytesIO(content), sheet_name=None)
                    for sheet_name, df in df_dict.items():
                        text += f"--- Sheet: {sheet_name} ---\n"
                        text += df.to_csv(index=False) + "\n\n"
                except Exception as e:
                    # 有些政府機關的 Excel 其實是 CSV 偽裝的，嘗試直接作為文字解碼
                    try:
                        text = content.decode("utf-8-sig")
                    except UnicodeDecodeError:
                        try:
                            text = content.decode("big5", errors="ignore")
                        except Exception:
                            text = ""
                            raise e
            except Exception as e:
                return JSONResponse(status_code=422, content={"error": f"Excel 解析失敗: {str(e)}。💡 系統提示：這可能是政府系統產生的舊版格式或檔案損毀，您可以直接「打開該 Excel，全選複製 (Ctrl+C)」，然後直接貼到系統的「文字方塊」中，AI 一樣能完美解析！"})
                
        # 4. CSV extraction
        elif fname.endswith(".csv") or "csv" in file.content_type:
            try:
                text = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                try:
                    text = content.decode("big5")
                except UnicodeDecodeError:
                    text = content.decode("utf-8", errors="ignore")
                    
        # 5. RTF extraction
        elif fname.endswith(".rtf") or "rtf" in (file.content_type or ""):
            text = _strip_rtf(content)
                
        # 6. TXT extraction
        else:
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                text = content.decode("big5", errors="ignore")
                
        if not text.strip():
            return JSONResponse(status_code=422, content={"error": "無法從檔案解讀出任何文字。"})
            
        return {"text": text.strip()}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"萃取文字發生錯誤：{str(e)}"})

