import base64
import binascii
import io
import os
import secrets
import threading
from contextlib import asynccontextmanager
from typing import Any, Iterator

import numpy as np
import pypdfium2 as pdfium
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict
from paddleocr import PaddleOCR
from starlette.requests import Request

MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_PDF_PAGES = 20
MAX_IMAGE_PIXELS = 40_000_000
OCR_TOKEN = os.environ.get("OCR_INTERNAL_TOKEN", "")
ocr_engine: PaddleOCR | None = None
inference_lock = threading.Lock()


class OcrRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    file: str
    fileType: int | None = None
    visualize: bool = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    global ocr_engine
    if not OCR_TOKEN:
        raise RuntimeError("OCR_INTERNAL_TOKEN must be configured")
    ocr_engine = PaddleOCR(use_angle_cls=True, lang="en", use_gpu=False, show_log=False)
    yield
    ocr_engine = None


app = FastAPI(title="ApexCare PaddleOCR", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.middleware("http")
async def bound_request_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > (MAX_FILE_BYTES * 4 // 3 + 1024 * 1024):
        return JSONResponse(status_code=413, content={"detail": "REQUEST_TOO_LARGE"})
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ready" if ocr_engine is not None else "starting"}


def _authorize(authorization: str | None) -> None:
    expected = f"Bearer {OCR_TOKEN}"
    if not OCR_TOKEN or authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="UNAUTHORIZED")


def _decode_file(value: str) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="INVALID_BASE64") from None
    if not data or len(data) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="FILE_SIZE_INVALID")
    return data


def _image_pages(data: bytes) -> Iterator[np.ndarray]:
    if data.startswith(b"%PDF-"):
        try:
            document = pdfium.PdfDocument(data)
            if len(document) < 1 or len(document) > MAX_PDF_PAGES:
                raise HTTPException(status_code=422, detail="PDF_PAGE_COUNT_INVALID")
            try:
                for page_index in range(len(document)):
                    bitmap = document[page_index].render(scale=1.7)
                    image = bitmap.to_pil()
                    if image.width * image.height > MAX_IMAGE_PIXELS:
                        raise HTTPException(status_code=422, detail="IMAGE_DIMENSIONS_INVALID")
                    yield np.asarray(image.convert("RGB"))
                    del bitmap, image
            finally:
                document.close()
            return
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=422, detail="INVALID_PDF") from None

    try:
        image = Image.open(io.BytesIO(data))
        image.verify()
        image = Image.open(io.BytesIO(data)).convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=422, detail="INVALID_IMAGE") from None
    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise HTTPException(status_code=422, detail="IMAGE_DIMENSIONS_INVALID")
    yield np.asarray(image)


def _recognize(page: np.ndarray) -> dict[str, Any]:
    if ocr_engine is None:
        raise HTTPException(status_code=503, detail="OCR_NOT_READY")
    with inference_lock:
        result = ocr_engine.ocr(page, cls=True)
    texts: list[str] = []
    scores: list[float | None] = []
    boxes: list[list[list[float]]] = []
    for line in (result[0] if result and result[0] else []):
        if not line or len(line) < 2 or not line[1]:
            continue
        text, score = line[1][0], line[1][1]
        if not isinstance(text, str) or not text.strip():
            continue
        texts.append(text.strip()[:1000])
        scores.append(float(score) if isinstance(score, (int, float)) else None)
        boxes.append([[float(point[0]), float(point[1])] for point in line[0]])
    return {"prunedResult": {"rec_texts": texts, "rec_scores": scores, "dt_polys": boxes}}


@app.post("/ocr")
def run_ocr(body: OcrRequest, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _authorize(authorization)
    raw = _decode_file(body.file)
    pages = _image_pages(raw)
    results = [_recognize(page) for page in pages]
    return {"errorCode": 0, "result": {"ocrResults": results}}
