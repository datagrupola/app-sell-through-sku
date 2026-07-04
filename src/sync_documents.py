import os
import re
from datetime import datetime, timezone, date, time
from typing import Any, Dict, List, Optional, Set

from bsale_client import BsaleClient
from supabase_client import SupabaseRestClient


SALE_DOCUMENT_TYPES = {10, 40, 44}
RETURN_DOCUMENT_TYPES = {39, 41}


def to_bool(value: Any) -> bool:
    return str(value) == "1" or value is True


def to_int_or_none(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_float_or_none(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_sku(value: Any) -> Optional[str]:
    if value is None:
        return None
    cleaned = str(value).strip().upper()
    return cleaned or None


def normalize_barcode(value: Any) -> str:
    if value is None:
        return ""
    cleaned = re.sub(r"\s+", "", str(value).strip())
    return cleaned or ""


def date_to_unix_utc(date_text: str, end_of_day: bool = False) -> int:
    y, m, d = [int(part) for part in date_text.split("-")]

    if end_of_day:
        dt = datetime.combine(date(y, m, d), time(23, 59, 59), tzinfo=timezone.utc)
    else:
        dt = datetime.combine(date(y, m, d), time(0, 0, 0), tzinfo=timezone.utc)

    return int(dt.timestamp())


def unix_to_date(value: Any) -> Optional[str]:
    unix_value = to_int_or_none(value)
    if unix_value is None:
        return None
    return datetime.fromtimestamp(unix_value, tz=timezone.utc).date().isoformat()


def movement_type(document_type_id: int) -> str:
    if document_type_id in SALE_DOCUMENT_TYPES:
        return "VENTA"
    if document_type_id in RETURN_DOCUMENT_TYPES:
        return "DEVOLUCION"
    return "OTRO"


def sign_for_document_type(document_type_id: int) -> int:
    if document_type_id in RETURN_DOCUMENT_TYPES:
        return -1
    return 1


def variant_row(variant: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    variant_id = to_int_or_none(variant.get("id"))
    if not variant_id:
        return None

    product = variant.get("product") or {}

    return {
        "variant_id": variant_id,
        "product_id": to_int_or_none(product.get("id")),
        "description": variant.get("description"),
        "code_raw": variant.get("code"),
        "barcode_raw": variant.get("barCode"),
        "state": to_int_or_none(variant.get("state")),
        "allow_negative_stock": to_bool(variant.get("allowNegativeStock")),
        "unlimited_stock": to_bool(variant.get("unlimitedStock")),
        "is_lot": to_bool(variant.get("isLot")),
        "raw_json": variant,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }


def alias_row(variant: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    variant_id = to_int_or_none(variant.get("id"))
    sku = normalize_sku(variant.get("code"))

    if not variant_id or not sku:
        return None

    product = variant.get("product") or {}

    return {
        "sku_norm": sku,
        "barcode_norm": normalize_barcode(variant.get("barCode")),
        "variant_id": variant_id,
        "product_id": to_int_or_none(product.get("id")),
        "description": variant.get("description"),
        "source_detected": "DOCUMENT_DETAIL",
        "is_current": False,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }


def document_row(doc: Dict[str, Any], office_id: int, document_type_id: int) -> Dict[str, Any]:
    return {
        "document_id": int(doc["id"]),
        "href": doc.get("href"),
        "emission_date_unix": to_int_or_none(doc.get("emissionDate")),
        "emission_date": unix_to_date(doc.get("emissionDate")),
        "office_id": office_id,
        "document_type_id": document_type_id,
        "document_number": to_int_or_none(doc.get("number")),
        "serial_number": str(doc.get("serialNumber") or ""),
        "state": to_int_or_none(doc.get("state")),
        "total_amount": to_float_or_none(doc.get("totalAmount")),
        "net_amount": to_float_or_none(doc.get("netAmount")),
        "raw_json": doc,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def document_detail_row(
    detail: Dict[str, Any],
    doc: Dict[str, Any],
    office_id: int,
    document_type_id: int,
) -> Optional[Dict[str, Any]]:
    variant = detail.get("variant") or {}
    variant_id = to_int_or_none(variant.get("id"))

    if not variant_id:
        return None

    sign = sign_for_document_type(document_type_id)
    qty = to_float_or_none(detail.get("quantity")) or 0
    amount = to_float_or_none(detail.get("totalAmount")) or 0

    return {
        "document_detail_id": int(detail["id"]),
        "document_id": int(doc["id"]),
        "emission_date": unix_to_date(doc.get("emissionDate")),
        "office_id": office_id,
        "document_type_id": document_type_id,
        "movement_type": movement_type(document_type_id),
        "variant_id": variant_id,
        "quantity": qty,
        "quantity_signed": qty * sign,
        "total_amount": amount,
        "total_amount_signed": amount * sign,
        "unit_value": to_float_or_none(detail.get("totalUnitValue")),
        "raw_json": detail,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def sync_documents_for_type(
    bsale: BsaleClient,
    db: SupabaseRestClient,
    office_id: int,
    document_type_id: int,
    start_unix: int,
    end_unix: int,
    max_pages: int,
) -> None:
    limit = 50
    offset = 0
    page_number = 0
    seen_variant_ids: Set[int] = set()

    print(
        f"[documents] start office={office_id} "
        f"document_type={document_type_id} max_pages={max_pages}"
    )

    while True:
        if max_pages > 0 and page_number >= max_pages:
            print(
                f"[documents] stopped by max_pages "
                f"office={office_id} document_type={document_type_id} pages={page_number}"
            )
            break

        page = bsale.list_documents_page(
            office_id=office_id,
            document_type_id=document_type_id,
            start_unix=start_unix,
            end_unix=end_unix,
            limit=limit,
            offset=offset,
        )

        docs = page.get("items", [])
        count = int(page.get("count", 0))

        if not docs:
            break

        document_rows: List[Dict[str, Any]] = []
        detail_rows: List[Dict[str, Any]] = []
        variant_rows: List[Dict[str, Any]] = []
        alias_rows: List[Dict[str, Any]] = []

        for doc in docs:
            document_rows.append(document_row(doc, office_id, document_type_id))

            details = (doc.get("details") or {}).get("items") or []

            for detail in details:
                variant = detail.get("variant") or {}
                variant_id = to_int_or_none(variant.get("id"))

                if variant_id and variant_id not in seen_variant_ids:
                    seen_variant_ids.add(variant_id)

                    row = variant_row(variant)
                    if row:
                        variant_rows.append(row)

                    alias = alias_row(variant)
                    if alias:
                        alias_rows.append(alias)

                drow = document_detail_row(
                    detail=detail,
                    doc=doc,
                    office_id=office_id,
                    document_type_id=document_type_id,
                )

                if drow:
                    detail_rows.append(drow)

        db.upsert("bsale_variants", variant_rows, on_conflict="variant_id")
        db.upsert("bsale_sku_aliases", alias_rows, on_conflict="variant_id,sku_norm,barcode_norm")
        db.upsert("bsale_documents_raw", document_rows, on_conflict="document_id")
        db.upsert("bsale_document_details", detail_rows, on_conflict="document_detail_id")

        offset += limit
        page_number += 1

        print(
            f"[documents] office={office_id} type={document_type_id} "
            f"page={page_number} offset={offset} docs_read={min(offset, count)}/{count} "
            f"details={len(detail_rows)}"
        )

        if offset >= count:
            break

    print(f"[documents] done office={office_id} document_type={document_type_id}")


def main() -> None:
    office_ids = [
        int(value.strip())
        for value in os.getenv("OFFICE_IDS", "2").split(",")
        if value.strip()
    ]

    document_type_ids = [
        int(value.strip())
        for value in os.getenv("DOCUMENT_TYPE_IDS", "40,41").split(",")
        if value.strip()
    ]

    start_date = os.getenv("START_DATE", "2025-09-13")
    end_date = os.getenv("END_DATE") or datetime.now(timezone.utc).date().isoformat()
    max_pages = int(os.getenv("MAX_DOCUMENT_PAGES_PER_TYPE", "0"))

    start_unix = date_to_unix_utc(start_date, end_of_day=False)
    end_unix = date_to_unix_utc(end_date, end_of_day=True)

    print(
        f"[documents] range start_date={start_date} end_date={end_date} "
        f"start_unix={start_unix} end_unix={end_unix}"
    )

    bsale = BsaleClient()
    db = SupabaseRestClient()

    for office_id in office_ids:
        for document_type_id in document_type_ids:
            sync_documents_for_type(
                bsale=bsale,
                db=db,
                office_id=office_id,
                document_type_id=document_type_id,
                start_unix=start_unix,
                end_unix=end_unix,
                max_pages=max_pages,
            )

    print("[documents] finished")


if __name__ == "__main__":
    main()