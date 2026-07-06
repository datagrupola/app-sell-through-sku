import os
import re
from datetime import datetime, timezone, date
from typing import Any, Dict, List, Optional, Set

from bsale_client import BsaleClient
from supabase_client import SupabaseRestClient


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


def unix_to_date(value: Any) -> Optional[str]:
    unix_value = to_int_or_none(value)
    if unix_value is None:
        return None
    return datetime.fromtimestamp(unix_value, tz=timezone.utc).date().isoformat()


def parse_date(date_text: str) -> date:
    y, m, d = [int(part) for part in date_text.split("-")]
    return date(y, m, d)


def date_in_range(date_text: Optional[str], start_day: date, end_day: date) -> bool:
    if not date_text:
        return False

    current_day = parse_date(date_text)
    return start_day <= current_day <= end_day


def classify_reception(reception: Dict[str, Any]) -> str:
    internal_dispatch = reception.get("internalDispatch") or {}
    internal_dispatch_id = to_int_or_none(internal_dispatch.get("id"))

    if internal_dispatch_id:
        return "RECEPCION_DESPACHO_INTERNO"

    if to_bool(reception.get("updateStock")):
        return "ENTRADA_STOCK"

    return "ENTRADA_IMPORTADA_AMBIGUA"


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
        "source_detected": "RECEPTION_DETAIL",
        "is_current": False,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }


def reception_row(reception: Dict[str, Any], office_id: int) -> Dict[str, Any]:
    internal_dispatch = reception.get("internalDispatch") or {}

    return {
        "reception_id": int(reception["id"]),
        "admission_date_unix": to_int_or_none(reception.get("admissionDate")),
        "admission_date": unix_to_date(reception.get("admissionDate")),
        "office_id": office_id,
        "note": reception.get("note"),
        "document": str(reception.get("document") or ""),
        "internal_dispatch_id": to_int_or_none(internal_dispatch.get("id")),
        "update_stock": to_bool(reception.get("updateStock")),
        "href": reception.get("href"),
        "raw_json": reception,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def reception_detail_row(
    detail: Dict[str, Any],
    reception: Dict[str, Any],
    office_id: int,
) -> Optional[Dict[str, Any]]:
    variant = detail.get("variant") or {}
    variant_id = to_int_or_none(variant.get("id"))

    if not variant_id:
        return None

    return {
        "reception_detail_id": int(detail["id"]),
        "reception_id": int(reception["id"]),
        "office_id": office_id,
        "admission_date": unix_to_date(reception.get("admissionDate")),
        "variant_id": variant_id,
        "quantity": to_float_or_none(detail.get("quantity")) or 0,
        "cost": to_float_or_none(detail.get("cost")),
        "variant_stock": to_float_or_none(detail.get("variantStock")),
        "tipo_entrada": classify_reception(reception),
        "raw_json": detail,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def sync_receptions_for_office(
    bsale: BsaleClient,
    db: SupabaseRestClient,
    office_id: int,
    start_day: date,
    end_day: date,
    max_pages: int,
    max_details: int,
) -> None:
    limit = 50
    offset = 0
    page_number = 0
    seen_variant_ids: Set[int] = set()

    print(
        f"[receptions] start office={office_id} "
        f"start_date={start_day.isoformat()} end_date={end_day.isoformat()} "
        f"max_pages={max_pages} max_details={max_details}"
    )

    while True:
        if max_pages > 0 and page_number >= max_pages:
            print(f"[receptions] stopped by max_pages office={office_id} pages={page_number}")
            break

        page = bsale.list_receptions_page(
            office_id=office_id,
            limit=limit,
            offset=offset,
        )

        receptions = page.get("items", [])
        count = int(page.get("count", 0))

        if not receptions:
            break

        reception_rows: List[Dict[str, Any]] = []
        detail_rows: List[Dict[str, Any]] = []
        variant_rows: List[Dict[str, Any]] = []
        alias_rows: List[Dict[str, Any]] = []

        for reception in receptions:
            admission_date = unix_to_date(reception.get("admissionDate"))

            if not date_in_range(admission_date, start_day, end_day):
                continue

            reception_rows.append(reception_row(reception, office_id))

            reception_id = int(reception["id"])
            details = bsale.list_reception_details(
                reception_id=reception_id,
                max_details=max_details,
            )

            for detail in details:
                variant = detail.get("variant") or {}
                variant_id = to_int_or_none(variant.get("id"))

                if variant_id and variant_id not in seen_variant_ids:
                    seen_variant_ids.add(variant_id)

                    try:
                        full_variant = bsale.get_variant(variant_id)
                    except Exception as exc:
                        print(f"[variants] failed variant_id={variant_id}: {exc}")
                        full_variant = variant

                    row = variant_row(full_variant)
                    if row:
                        variant_rows.append(row)

                    alias = alias_row(full_variant)
                    if alias:
                        alias_rows.append(alias)

                drow = reception_detail_row(
                    detail=detail,
                    reception=reception,
                    office_id=office_id,
                )

                if drow:
                    detail_rows.append(drow)

        db.upsert("bsale_variants", variant_rows, on_conflict="variant_id")
        db.insert_ignore("bsale_sku_aliases", alias_rows, on_conflict="variant_id,sku_norm,barcode_norm")
        db.upsert("bsale_receptions_raw", reception_rows, on_conflict="reception_id")
        db.upsert("bsale_reception_details", detail_rows, on_conflict="reception_detail_id")

        offset += limit
        page_number += 1

        print(
            f"[receptions] office={office_id} page={page_number} "
            f"offset={offset} read={min(offset, count)}/{count} "
            f"receptions_upsert={len(reception_rows)} details_upsert={len(detail_rows)}"
        )

        if offset >= count:
            break

    print(f"[receptions] done office={office_id}")


def main() -> None:
    office_ids = [
        int(value.strip())
        for value in os.getenv("OFFICE_IDS", "2").split(",")
        if value.strip()
    ]

    start_date_text = os.getenv("START_DATE", "2025-07-06")
    end_date_text = os.getenv("END_DATE") or datetime.now(timezone.utc).date().isoformat()
    max_pages = int(os.getenv("MAX_RECEPTION_PAGES_PER_OFFICE", "0"))
    max_details = int(os.getenv("MAX_RECEPTION_DETAILS", "500"))

    start_day = parse_date(start_date_text)
    end_day = parse_date(end_date_text)

    print(
        f"[receptions] sync start_date={start_date_text} "
        f"end_date={end_date_text} max_pages={max_pages}"
    )

    bsale = BsaleClient()
    db = SupabaseRestClient()

    for office_id in office_ids:
        sync_receptions_for_office(
            bsale=bsale,
            db=db,
            office_id=office_id,
            start_day=start_day,
            end_day=end_day,
            max_pages=max_pages,
            max_details=max_details,
        )

    print("[receptions] finished")


if __name__ == "__main__":
    main()
