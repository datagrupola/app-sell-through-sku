import os
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


def unix_to_date(value: Any) -> Optional[str]:
    unix_value = to_int_or_none(value)
    if unix_value is None:
        return None
    return datetime.fromtimestamp(unix_value, tz=timezone.utc).date().isoformat()


def get_consumption_date_unix(consumption: Dict[str, Any]) -> Optional[int]:
    for key in ["consumptionDate", "date", "recordDate", "creationDate"]:
        value = to_int_or_none(consumption.get(key))
        if value is not None:
            return value
    return None


def classify_consumption(note: Optional[str], consumption_type_id: Optional[int], update_stock: bool) -> str:
    note_norm = (note or "").strip().upper()

    if "CONSUMO MASIVO DESACTIVACION PRODUCTOS" in note_norm:
        return "DESACTIVACION_MASIVA"

    if "ACTUALIZAR RECEPCION" in note_norm:
        return "CORRECCION_RECEPCION"

    if "AJUSTE DE STOCK" in note_norm:
        return "AJUSTE_NEGATIVO"

    if "INVENTORY" in note_norm:
        return "AJUSTE_INVENTARIO"

    if "MERMA" in note_norm:
        return "MERMA"

    if note_norm.startswith("CONSUMO /"):
        return "CONSUMO_MANUAL"

    if consumption_type_id == 2:
        return "CONSUMO_MANUAL_AMBIGUO"

    if consumption_type_id == 1 and update_stock:
        return "CONSUMO_STOCK"

    if consumption_type_id == 1 and not update_stock:
        return "CONSUMO_SIN_UPDATE_STOCK"

    return "CONSUMO_NO_CLASIFICADO"


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


def normalize_sku(value: Any) -> Optional[str]:
    if value is None:
        return None
    cleaned = str(value).strip().upper()
    return cleaned or None


def normalize_barcode(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().replace(" ", "") or ""


def alias_row(variant: Dict[str, Any]) -> Optional[Dict[str, Any]]:
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
        "source_detected": "CONSUMPTION",
        "is_current": False,
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
    }


def consumption_header_row(consumption: Dict[str, Any], office_id: int) -> Dict[str, Any]:
    consumption_date_unix = get_consumption_date_unix(consumption)

    return {
        "consumption_id": int(consumption["id"]),
        "href": consumption.get("href"),
        "consumption_date_unix": consumption_date_unix,
        "consumption_date": unix_to_date(consumption_date_unix),
        "office_id": office_id,
        "note": consumption.get("note"),
        "consumption_type_id": to_int_or_none(consumption.get("consumptionTypeId")),
        "update_stock": to_bool(consumption.get("updateStock")),
        "raw_json": consumption,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def consumption_detail_row(
    detail: Dict[str, Any],
    consumption: Dict[str, Any],
    office_id: int,
    tipo_consumo: str,
) -> Optional[Dict[str, Any]]:
    variant = detail.get("variant") or {}
    variant_id = to_int_or_none(variant.get("id"))

    if not variant_id:
        return None

    quantity = to_float_or_none(detail.get("quantity")) or 0
    consumption_date_unix = get_consumption_date_unix(consumption)

    return {
        "consumption_detail_id": int(detail["id"]),
        "consumption_id": int(consumption["id"]),
        "office_id": office_id,
        "consumption_date": unix_to_date(consumption_date_unix),
        "variant_id": variant_id,
        "quantity": quantity,
        "quantity_signed": quantity * -1,
        "tipo_consumo": tipo_consumo,
        "raw_json": detail,
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def sync_consumptions(bsale: BsaleClient, db: SupabaseRestClient, office_id: int) -> None:
    max_pages = int(os.getenv("MAX_CONSUMPTION_PAGES", "0"))
    max_details = int(os.getenv("MAX_DETAILS_PER_CONSUMPTION", "300"))

    limit = 50
    offset = 0
    page_number = 0

    print(
        f"[consumptions] start office_id={office_id} "
        f"max_pages={max_pages} max_details={max_details}"
    )

    while True:
        if max_pages > 0 and page_number >= max_pages:
            print(f"[consumptions] stopped by max_pages office_id={office_id} pages={page_number}")
            break

        page = bsale.list_consumptions_page(
            office_id=office_id,
            limit=limit,
            offset=offset,
        )

        consumptions = page.get("items", [])
        count = int(page.get("count", 0))

        if not consumptions:
            break

        print(
            f"[consumptions] office_id={office_id} "
            f"page={page_number + 1} offset={offset} items={len(consumptions)} total={count}"
        )

        for consumption in consumptions:
            details_count = int((consumption.get("details") or {}).get("count") or 0)
            consumption_type_id = to_int_or_none(consumption.get("consumptionTypeId"))
            update_stock = to_bool(consumption.get("updateStock"))

            tipo_consumo = classify_consumption(
                note=consumption.get("note"),
                consumption_type_id=consumption_type_id,
                update_stock=update_stock,
            )

            db.upsert_one(
                "bsale_consumptions_raw",
                consumption_header_row(consumption, office_id),
                on_conflict="consumption_id",
            )

            if details_count == 0:
                continue

            details = bsale.list_consumption_details(
                consumption_id=int(consumption["id"]),
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

                alias = alias_row(full_variant)
                if alias:
                    db.insert_ignore(
                        "bsale_sku_aliases",
                        [alias],
                        on_conflict="variant_id,sku_norm,barcode_norm",
                    )

                row = consumption_detail_row(
                    detail=detail,
                    consumption=consumption,
                    office_id=office_id,
                    tipo_consumo=tipo_consumo,
                )

                if row:
                    detail_rows.append(row)

            db.upsert(
                "bsale_consumption_details",
                detail_rows,
                on_conflict="consumption_detail_id",
            )

        offset += limit
        page_number += 1

        if offset >= count:
            break

    print(f"[consumptions] done office_id={office_id}")


def main() -> None:
    office_ids = [
        int(value.strip())
        for value in os.getenv("OFFICE_IDS", "2").split(",")
        if value.strip()
    ]

    bsale = BsaleClient()
    db = SupabaseRestClient()

    for office_id in office_ids:
        sync_consumptions(bsale, db, office_id)

    print("[consumptions] finished")


if __name__ == "__main__":
    main()