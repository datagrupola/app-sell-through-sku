import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

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


def classify_reception(note: Optional[str], document: Optional[str], internal_dispatch_id: Optional[int], details_count: int) -> str:
    note_norm = (note or "").strip().upper()
    document_norm = (document or "").strip().upper()

    if details_count == 0:
        return "EXCLUIR_SIN_DETALLE"

    if internal_dispatch_id and internal_dispatch_id > 0:
        return "TRASPASO_INTERNO_ENTRADA"

    if "AJUSTE DE STOCK" in note_norm:
        return "AJUSTE_POSITIVO"

    if "IMPORTAR STOCK: SOPORTE BSALE" in note_norm:
        return "STOCK_INICIAL_IMPORTADO"

    if "IMPORTAR STOCK" in note_norm and document_norm == "SIN DOCUMENTO":
        return "ENTRADA_IMPORTADA_AMBIGUA"

    if "IMPORTAR STOCK" in note_norm:
        return "ENTRADA_IMPORTADA"

    return "ENTRADA_NO_CLASIFICADA"


def variant_row(variant: Dict[str, Any]) -> Dict[str, Any]:
    product = variant.get("product") or {}

    return {
        "variant_id": int(variant["id"]),
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


def alias_row(variant: Dict[str, Any], source_detected: str, is_current: bool) -> Optional[Dict[str, Any]]:
    sku = normalize_sku(variant.get("code"))
    if not sku:
        return None

    product = variant.get("product") or {}

    return {
        "sku_norm": sku,
        "barcode_norm": normalize_barcode(variant.get("barCode")),
        "variant_id": int(variant["id"]),
        "product_id": to_int_or_none(product.get("id")),
        "description": variant.get("description"),
        "source_detected": source_detected,
        "is_current": is_current,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }


def office_row(office: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "office_id": int(office["id"]),
        "name": office.get("name"),
        "city": office.get("city"),
        "district": office.get("district"),
        "state": to_int_or_none(office.get("state")),
        "raw_json": office,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def stock_row(stock: Dict[str, Any], office_id: int) -> Dict[str, Any]:
    variant = stock.get("variant") or {}

    return {
        "office_id": office_id,
        "variant_id": int(variant["id"]),
        "stock_id": to_int_or_none(stock.get("id")),
        "sku_norm": normalize_sku(variant.get("code")),
        "barcode_norm": normalize_barcode(variant.get("barCode")),
        "quantity": to_float_or_none(stock.get("quantity")) or 0,
        "quantity_reserved": to_float_or_none(stock.get("quantityReserved")) or 0,
        "quantity_available": to_float_or_none(stock.get("quantityAvailable")) or 0,
        "raw_json": stock,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def reception_header_row(reception: Dict[str, Any], office_id: int) -> Dict[str, Any]:
    internal_dispatch_id = to_int_or_none(reception.get("internalDispatchId"))
    details_count = int((reception.get("details") or {}).get("count") or 0)

    return {
        "reception_id": int(reception["id"]),
        "admission_date_unix": to_int_or_none(reception.get("admissionDate")),
        "admission_date": unix_to_date(reception.get("admissionDate")),
        "office_id": office_id,
        "note": reception.get("note"),
        "document": reception.get("document"),
        "internal_dispatch_id": internal_dispatch_id,
        "update_stock": to_bool(reception.get("updateStock")),
        "href": reception.get("href"),
        "raw_json": reception,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def reception_detail_row(
    detail: Dict[str, Any],
    reception: Dict[str, Any],
    office_id: int,
    tipo_entrada: str,
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
        "quantity": to_float_or_none(detail.get("quantity")),
        "cost": to_float_or_none(detail.get("cost")),
        "variant_stock": to_float_or_none(detail.get("variantStock")),
        "tipo_entrada": tipo_entrada,
        "raw_json": detail,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def sync_office(bsale: BsaleClient, db: SupabaseRestClient, office_id: int) -> None:
    office = bsale.get_office(office_id)
    db.upsert_one("bsale_offices", office_row(office), on_conflict="office_id")
    print(f"[office] synced office_id={office_id}")


def sync_stock(bsale: BsaleClient, db: SupabaseRestClient, office_id: int) -> None:
    print(f"[stock] start office_id={office_id}")

    stocks = bsale.list_all_stocks(office_id=office_id, limit=25)

    variant_rows: List[Dict[str, Any]] = []
    alias_rows: List[Dict[str, Any]] = []
    stock_rows: List[Dict[str, Any]] = []

    for stock in stocks:
        variant = stock.get("variant") or {}
        if not variant.get("id"):
            continue

        variant_rows.append(variant_row(variant))

        alias = alias_row(variant, source_detected="STOCK/CATALOGO", is_current=True)
        if alias:
            alias_rows.append(alias)

        stock_rows.append(stock_row(stock, office_id=office_id))

    db.upsert("bsale_variants", variant_rows, on_conflict="variant_id")
    db.upsert("bsale_sku_aliases", alias_rows, on_conflict="variant_id,sku_norm,barcode_norm")
    db.upsert("bsale_stock_current", stock_rows, on_conflict="office_id,variant_id")

    print(
        f"[stock] done office_id={office_id} "
        f"variants={len(variant_rows)} aliases={len(alias_rows)} stocks={len(stock_rows)}"
    )


def sync_receptions(bsale: BsaleClient, db: SupabaseRestClient, office_id: int) -> None:
    max_pages = int(os.getenv("MAX_RECEPTION_PAGES", "1"))
    max_details = int(os.getenv("MAX_DETAILS_PER_RECEPTION", "300"))

    print(f"[receptions] start office_id={office_id} max_pages={max_pages} max_details={max_details}")

    limit = 50
    offset = 0

    for page_number in range(max_pages):
        page = bsale.list_receptions_page(office_id=office_id, limit=limit, offset=offset)
        receptions = page.get("items", [])

        if not receptions:
            print(f"[receptions] no more items office_id={office_id} offset={offset}")
            break

        print(f"[receptions] office_id={office_id} page={page_number + 1} items={len(receptions)}")

        for reception in receptions:
            details_count = int((reception.get("details") or {}).get("count") or 0)
            internal_dispatch_id = to_int_or_none(reception.get("internalDispatchId"))

            tipo_entrada = classify_reception(
                note=reception.get("note"),
                document=reception.get("document"),
                internal_dispatch_id=internal_dispatch_id,
                details_count=details_count,
            )

            db.upsert_one(
                "bsale_receptions_raw",
                reception_header_row(reception, office_id=office_id),
                on_conflict="reception_id",
            )

            if details_count == 0:
                continue

            details = bsale.list_reception_details(
                reception_id=int(reception["id"]),
                limit=50,
                max_details=max_details,
            )

            detail_rows: List[Dict[str, Any]] = []

            for detail in details:
                variant = detail.get("variant") or {}
                variant_id = to_int_or_none(variant.get("id"))

                if not variant_id:
                    continue

                full_variant = bsale.get_variant(variant_id)

                db.upsert_one(
                    "bsale_variants",
                    variant_row(full_variant),
                    on_conflict="variant_id",
                )

                alias = alias_row(
                    full_variant,
                    source_detected="RECEPCION",
                    is_current=False,
                )

                if alias:
                    db.upsert_one(
                        "bsale_sku_aliases",
                        alias,
                        on_conflict="variant_id,sku_norm,barcode_norm",
                    )

                row = reception_detail_row(
                    detail=detail,
                    reception=reception,
                    office_id=office_id,
                    tipo_entrada=tipo_entrada,
                )

                if row:
                    detail_rows.append(row)

            db.upsert(
                "bsale_reception_details",
                detail_rows,
                on_conflict="reception_detail_id",
            )

        offset += limit

    print(f"[receptions] done office_id={office_id}")


def main() -> None:
    office_ids = [
        int(value.strip())
        for value in os.getenv("OFFICE_IDS", "2").split(",")
        if value.strip()
    ]

    bsale = BsaleClient()
    db = SupabaseRestClient()

    for office_id in office_ids:
        sync_office(bsale, db, office_id)
        sync_stock(bsale, db, office_id)
        sync_receptions(bsale, db, office_id)

    print("[sync] finished")


if __name__ == "__main__":
    main()