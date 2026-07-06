import os
import time
from datetime import datetime, timezone, date, timedelta, time as dt_time
from typing import Any, Dict, List, Optional, Set

import requests

from bsale_client import BsaleClient


SALE_DOCUMENT_TYPES = {10, 40, 44}
RETURN_DOCUMENT_TYPES = {39, 41}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_int_or_none(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def to_bool(value: Any) -> bool:
    return str(value) == "1" or value is True


def normalize_sku(value: Any) -> str:
    return str(value or "").strip().upper()


def normalize_barcode(value: Any) -> str:
    return str(value or "").strip().replace(" ", "")


def unix_to_date(value: Any) -> Optional[str]:
    unix_value = to_int_or_none(value)
    if unix_value is None:
        return None
    return datetime.fromtimestamp(unix_value, tz=timezone.utc).date().isoformat()


def parse_date(date_text: str) -> date:
    y, m, d = [int(part) for part in date_text.split("-")]
    return date(y, m, d)


def date_to_unix_utc(date_text: str, end_of_day: bool = False) -> int:
    y, m, d = [int(part) for part in date_text.split("-")]

    if end_of_day:
        dt = datetime.combine(date(y, m, d), dt_time(23, 59, 59), tzinfo=timezone.utc)
    else:
        dt = datetime.combine(date(y, m, d), dt_time(0, 0, 0), tzinfo=timezone.utc)

    return int(dt.timestamp())


def iter_dates(start_day: date, end_day: date):
    current = start_day
    while current <= end_day:
        yield current
        current = current + timedelta(days=1)


def in_date_range(date_text: Optional[str], start_day: date, end_day: date) -> bool:
    if not date_text:
        return False
    current = parse_date(date_text)
    return start_day <= current <= end_day


def movement_type_for_document(document_type_id: int) -> str:
    if document_type_id in SALE_DOCUMENT_TYPES:
        return "VENTA"
    if document_type_id in RETURN_DOCUMENT_TYPES:
        return "DEVOLUCION"
    return "OTRO_DOCUMENTO"


def sign_for_document(document_type_id: int) -> int:
    if document_type_id in RETURN_DOCUMENT_TYPES:
        return -1
    return 1


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


def classify_reception(reception: Dict[str, Any]) -> str:
    internal_dispatch = reception.get("internalDispatch") or {}
    internal_dispatch_id = to_int_or_none(internal_dispatch.get("id"))

    if internal_dispatch_id:
        return "RECEPCION_DESPACHO_INTERNO"

    if to_bool(reception.get("updateStock")):
        return "ENTRADA_STOCK"

    return "ENTRADA_IMPORTADA_AMBIGUA"


class SupabaseJobClient:
    def __init__(self) -> None:
        self.base_url = os.environ["SUPABASE_URL"].rstrip("/")
        self.service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

        self.session = requests.Session()
        self.session.headers.update({
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
        })

    def get_rows(self, table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
        response = self.session.get(
            f"{self.base_url}/rest/v1/{table}",
            params=params,
            timeout=180,
        )

        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase GET error {response.status_code} on {table}: {response.text[:2000]}"
            )

        return response.json()

    def patch_rows(self, table: str, filters: Dict[str, str], payload: Dict[str, Any]) -> None:
        response = self.session.patch(
            f"{self.base_url}/rest/v1/{table}",
            params=filters,
            headers={"Prefer": "return=minimal"},
            json=payload,
            timeout=180,
        )

        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase PATCH error {response.status_code} on {table}: {response.text[:2000]}"
            )

    def get_job(self) -> Optional[Dict[str, Any]]:
        job_id = os.getenv("LIVE_TRACEABILITY_JOB_ID", "").strip()

        if job_id:
            rows = self.get_rows(
                "bsale_live_traceability_jobs",
                {
                    "select": "*",
                    "id": f"eq.{job_id}",
                    "limit": "1",
                },
            )
        else:
            rows = self.get_rows(
                "bsale_live_traceability_jobs",
                {
                    "select": "*",
                    "status": "eq.queued",
                    "order": "requested_at.asc",
                    "limit": "1",
                },
            )

        return rows[0] if rows else None

    def update_job(self, job_id: str, payload: Dict[str, Any]) -> None:
        self.patch_rows(
            "bsale_live_traceability_jobs",
            {"id": f"eq.{job_id}"},
            payload,
        )

    def find_stock_index(self, query: str, office_ids: List[int]) -> List[Dict[str, Any]]:
        sku_query = normalize_sku(query)
        barcode_query = normalize_barcode(query)
        office_filter = f"in.({','.join(str(x) for x in office_ids)})"

        rows: List[Dict[str, Any]] = []

        for column, value in [("sku_norm", sku_query), ("barcode_norm", barcode_query)]:
            if not value:
                continue

            params = {
                "select": "office_id,variant_id,stock_id,sku_norm,barcode_norm,quantity,quantity_reserved,quantity_available,synced_at",
                column: f"eq.{value}",
                "office_id": office_filter,
            }

            rows.extend(self.get_rows("bsale_stock_current", params))

        seen = set()
        deduped = []

        for row in rows:
            key = f"{row.get('office_id')}:{row.get('variant_id')}:{row.get('stock_id')}"
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)

        return deduped

    def find_alias_index(self, query: str) -> List[Dict[str, Any]]:
        sku_query = normalize_sku(query)
        barcode_query = normalize_barcode(query)

        rows: List[Dict[str, Any]] = []

        for column, value in [("sku_norm", sku_query), ("barcode_norm", barcode_query)]:
            if not value:
                continue

            params = {
                "select": "variant_id,sku_norm,barcode_norm,product_id,description,last_seen_at",
                column: f"eq.{value}",
            }

            rows.extend(self.get_rows("bsale_sku_aliases", params))

        seen = set()
        deduped = []

        for row in rows:
            key = f"{row.get('variant_id')}:{row.get('sku_norm')}:{row.get('barcode_norm')}"
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)

        return deduped


def get_live_stock_matches(bsale: BsaleClient, stock_index_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    matches = []

    for row in stock_index_rows:
        stock_id = to_int_or_none(row.get("stock_id"))

        if not stock_id:
            continue

        try:
            live = bsale.get(
                f"stocks/{stock_id}.json",
                params={"expand": "[office,variant]"},
            )

            office = live.get("office") or {}
            variant = live.get("variant") or {}

            matches.append({
                "source": "BSALE_LIVE",
                "live_ok": True,
                "office_id": to_int_or_none(office.get("id")) or row.get("office_id"),
                "office_name": office.get("name"),
                "variant_id": to_int_or_none(variant.get("id")) or row.get("variant_id"),
                "stock_id": stock_id,
                "sku": variant.get("code") or row.get("sku_norm"),
                "barcode": variant.get("barCode") or row.get("barcode_norm"),
                "quantity": to_float(live.get("quantity")),
                "quantity_reserved": to_float(live.get("quantityReserved")),
                "quantity_available": to_float(live.get("quantityAvailable")),
                "index_synced_at": row.get("synced_at"),
            })
        except Exception as exc:
            matches.append({
                "source": "SUPABASE_INDEX_FALLBACK",
                "live_ok": False,
                "live_error": str(exc),
                "office_id": row.get("office_id"),
                "office_name": None,
                "variant_id": row.get("variant_id"),
                "stock_id": stock_id,
                "sku": row.get("sku_norm"),
                "barcode": row.get("barcode_norm"),
                "quantity": to_float(row.get("quantity")),
                "quantity_reserved": to_float(row.get("quantity_reserved")),
                "quantity_available": to_float(row.get("quantity_available")),
                "index_synced_at": row.get("synced_at"),
            })

    return matches


def scan_documents(
    bsale: BsaleClient,
    office_ids: List[int],
    variant_ids: Set[int],
    start_day: date,
    end_day: date,
) -> Dict[str, Any]:
    document_type_ids = [
        int(value.strip())
        for value in os.getenv("LIVE_DOCUMENT_TYPE_IDS", "10,39,40,41,44").split(",")
        if value.strip()
    ]

    max_pages = int(os.getenv("LIVE_MAX_DOCUMENT_PAGES_PER_DAY_TYPE", "0"))
    limit = 50

    movements = []
    stats = {
        "pages": 0,
        "documents_seen": 0,
        "details_seen": 0,
        "matches": 0,
    }

    for office_id in office_ids:
        for current_day in iter_dates(start_day, end_day):
            day_text = current_day.isoformat()
            start_unix = date_to_unix_utc(day_text, end_of_day=False)
            end_unix = date_to_unix_utc(day_text, end_of_day=True)

            for document_type_id in document_type_ids:
                offset = 0
                page_number = 0

                while True:
                    if max_pages > 0 and page_number >= max_pages:
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
                    stats["pages"] += 1

                    if not docs:
                        break

                    for doc in docs:
                        stats["documents_seen"] += 1
                        details = (doc.get("details") or {}).get("items") or []

                        for detail in details:
                            stats["details_seen"] += 1

                            variant = detail.get("variant") or {}
                            variant_id = to_int_or_none(variant.get("id"))

                            if variant_id not in variant_ids:
                                continue

                            qty = to_float(detail.get("quantity"))
                            amount = to_float(detail.get("totalAmount"))
                            sign = sign_for_document(document_type_id)
                            movement_type = movement_type_for_document(document_type_id)

                            movements.append({
                                "source": "documents",
                                "movement_group": "VENTA" if movement_type == "VENTA" else "DEVOLUCION",
                                "movement_type": movement_type,
                                "office_id": office_id,
                                "movement_date": unix_to_date(doc.get("emissionDate")),
                                "document_id": to_int_or_none(doc.get("id")),
                                "document_detail_id": to_int_or_none(detail.get("id")),
                                "document_type_id": document_type_id,
                                "variant_id": variant_id,
                                "quantity": qty,
                                "quantity_signed": qty * sign,
                                "total_amount": amount,
                                "total_amount_signed": amount * sign,
                                "note": f"Documento {doc.get('number')}",
                            })

                            stats["matches"] += 1

                    offset += limit
                    page_number += 1

                    if offset >= count:
                        break

    return {
        "movements": movements,
        "stats": stats,
    }


def scan_receptions(
    bsale: BsaleClient,
    office_ids: List[int],
    variant_ids: Set[int],
    start_day: date,
    end_day: date,
) -> Dict[str, Any]:
    max_pages = int(os.getenv("LIVE_MAX_RECEPTION_PAGES_PER_OFFICE", "0"))
    max_details = int(os.getenv("LIVE_MAX_RECEPTION_DETAILS", "500"))
    limit = 50

    movements = []
    stats = {
        "pages": 0,
        "receptions_seen": 0,
        "details_seen": 0,
        "matches": 0,
    }

    for office_id in office_ids:
        offset = 0
        page_number = 0

        while True:
            if max_pages > 0 and page_number >= max_pages:
                break

            page = bsale.list_receptions_page(
                office_id=office_id,
                limit=limit,
                offset=offset,
            )

            receptions = page.get("items", [])
            count = int(page.get("count", 0))
            stats["pages"] += 1

            if not receptions:
                break

            for reception in receptions:
                stats["receptions_seen"] += 1
                admission_date = unix_to_date(reception.get("admissionDate"))

                if not in_date_range(admission_date, start_day, end_day):
                    continue

                reception_id = int(reception["id"])

                details = bsale.list_reception_details(
                    reception_id=reception_id,
                    limit=50,
                    max_details=max_details,
                )

                for detail in details:
                    stats["details_seen"] += 1

                    variant = detail.get("variant") or {}
                    variant_id = to_int_or_none(variant.get("id"))

                    if variant_id not in variant_ids:
                        continue

                    qty = to_float(detail.get("quantity"))

                    movements.append({
                        "source": "receptions",
                        "movement_group": "ENTRADA",
                        "movement_type": classify_reception(reception),
                        "office_id": office_id,
                        "movement_date": admission_date,
                        "reception_id": reception_id,
                        "reception_detail_id": to_int_or_none(detail.get("id")),
                        "variant_id": variant_id,
                        "quantity": qty,
                        "quantity_signed": qty,
                        "cost": to_float(detail.get("cost")),
                        "variant_stock": to_float(detail.get("variantStock")),
                        "note": reception.get("note") or reception.get("document"),
                    })

                    stats["matches"] += 1

            offset += limit
            page_number += 1

            if offset >= count:
                break

    return {
        "movements": movements,
        "stats": stats,
    }


def scan_consumptions(
    bsale: BsaleClient,
    office_ids: List[int],
    variant_ids: Set[int],
    start_day: date,
    end_day: date,
) -> Dict[str, Any]:
    max_pages = int(os.getenv("LIVE_MAX_CONSUMPTION_PAGES_PER_OFFICE", "0"))
    max_details = int(os.getenv("LIVE_MAX_CONSUMPTION_DETAILS", "500"))
    limit = 50

    movements = []
    stats = {
        "pages": 0,
        "consumptions_seen": 0,
        "details_seen": 0,
        "matches": 0,
    }

    for office_id in office_ids:
        offset = 0
        page_number = 0

        while True:
            if max_pages > 0 and page_number >= max_pages:
                break

            page = bsale.list_consumptions_page(
                office_id=office_id,
                limit=limit,
                offset=offset,
            )

            consumptions = page.get("items", [])
            count = int(page.get("count", 0))
            stats["pages"] += 1

            if not consumptions:
                break

            for consumption in consumptions:
                stats["consumptions_seen"] += 1

                consumption_date = unix_to_date(get_consumption_date_unix(consumption))

                if not in_date_range(consumption_date, start_day, end_day):
                    continue

                consumption_id = int(consumption["id"])
                consumption_type_id = to_int_or_none(consumption.get("consumptionTypeId"))
                update_stock = to_bool(consumption.get("updateStock"))

                tipo_consumo = classify_consumption(
                    note=consumption.get("note"),
                    consumption_type_id=consumption_type_id,
                    update_stock=update_stock,
                )

                details = bsale.list_consumption_details(
                    consumption_id=consumption_id,
                    limit=50,
                    max_details=max_details,
                )

                for detail in details:
                    stats["details_seen"] += 1

                    variant = detail.get("variant") or {}
                    variant_id = to_int_or_none(variant.get("id"))

                    if variant_id not in variant_ids:
                        continue

                    qty = to_float(detail.get("quantity"))

                    movements.append({
                        "source": "consumptions",
                        "movement_group": "CONSUMO_NO_VENTA",
                        "movement_type": tipo_consumo,
                        "office_id": office_id,
                        "movement_date": consumption_date,
                        "consumption_id": consumption_id,
                        "consumption_detail_id": to_int_or_none(detail.get("id")),
                        "variant_id": variant_id,
                        "quantity": qty,
                        "quantity_signed": qty * -1,
                        "note": consumption.get("note"),
                    })

                    stats["matches"] += 1

            offset += limit
            page_number += 1

            if offset >= count:
                break

    return {
        "movements": movements,
        "stats": stats,
    }


def build_summary(
    stock_matches: List[Dict[str, Any]],
    movements: List[Dict[str, Any]],
) -> Dict[str, Any]:
    received = sum(to_float(m.get("quantity")) for m in movements if m.get("movement_group") == "ENTRADA")
    sold = sum(to_float(m.get("quantity")) for m in movements if m.get("movement_group") == "VENTA")
    returned = sum(to_float(m.get("quantity")) for m in movements if m.get("movement_group") == "DEVOLUCION")
    consumed = sum(to_float(m.get("quantity")) for m in movements if m.get("movement_group") == "CONSUMO_NO_VENTA")

    stock_actual = sum(to_float(s.get("quantity")) for s in stock_matches)
    stock_disponible = sum(to_float(s.get("quantity_available")) for s in stock_matches)

    net_sold = sold - returned
    sell_through_pct = None

    if received > 0:
        sell_through_pct = round((net_sold / received) * 100, 2)

    return {
        "piezas_recibidas": received,
        "piezas_vendidas": sold,
        "piezas_devueltas": returned,
        "piezas_netas_venta": net_sold,
        "piezas_consumidas_no_venta": consumed,
        "stock_actual": stock_actual,
        "stock_disponible": stock_disponible,
        "sell_through_pct": sell_through_pct,
    }


def run_job(job: Dict[str, Any]) -> Dict[str, Any]:
    job_id = job["id"]
    query = job["query_text"]
    office_ids = [int(value) for value in job.get("office_ids") or [2, 3, 4]]

    lookback_days = int(os.getenv("LIVE_TRACEABILITY_LOOKBACK_DAYS", "365"))
    end_day = datetime.now(timezone.utc).date()
    start_day = end_day - timedelta(days=lookback_days)

    print(
        f"[live-job] start job_id={job_id} query={query} "
        f"offices={office_ids} start={start_day.isoformat()} end={end_day.isoformat()}"
    )

    db = SupabaseJobClient()
    bsale = BsaleClient()

    stock_index_rows = db.find_stock_index(query, office_ids)
    alias_rows = db.find_alias_index(query)

    variant_ids = {
        int(row["variant_id"])
        for row in stock_index_rows + alias_rows
        if row.get("variant_id") is not None
    }

    stock_matches = get_live_stock_matches(bsale, stock_index_rows)

    if not variant_ids:
        return {
            "stock_result": {
                "found": False,
                "stock_matches": [],
                "index_matches": 0,
            },
            "traceability_result": {
                "found": False,
                "message": "No se encontró variant_id en bsale_stock_current ni bsale_sku_aliases.",
                "movements": [],
                "summary": build_summary([], []),
                "scan_stats": {},
            },
        }

    document_result = scan_documents(
        bsale=bsale,
        office_ids=office_ids,
        variant_ids=variant_ids,
        start_day=start_day,
        end_day=end_day,
    )

    reception_result = scan_receptions(
        bsale=bsale,
        office_ids=office_ids,
        variant_ids=variant_ids,
        start_day=start_day,
        end_day=end_day,
    )

    consumption_result = scan_consumptions(
        bsale=bsale,
        office_ids=office_ids,
        variant_ids=variant_ids,
        start_day=start_day,
        end_day=end_day,
    )

    movements = (
        reception_result["movements"]
        + document_result["movements"]
        + consumption_result["movements"]
    )

    movements.sort(
        key=lambda item: (
            item.get("movement_date") or "",
            item.get("source") or "",
        ),
        reverse=True,
    )

    summary = build_summary(stock_matches, movements)

    return {
        "stock_result": {
            "found": len(stock_matches) > 0,
            "stock_matches": stock_matches,
            "index_matches": len(stock_index_rows),
            "alias_matches": len(alias_rows),
            "variant_ids": sorted(variant_ids),
        },
        "traceability_result": {
            "found": len(movements) > 0,
            "query": query,
            "office_ids": office_ids,
            "lookback_days": lookback_days,
            "start_date": start_day.isoformat(),
            "end_date": end_day.isoformat(),
            "variant_ids": sorted(variant_ids),
            "summary": summary,
            "movements": movements,
            "scan_stats": {
                "documents": document_result["stats"],
                "receptions": reception_result["stats"],
                "consumptions": consumption_result["stats"],
            },
        },
    }


def main() -> None:
    db = SupabaseJobClient()
    job = db.get_job()

    if not job:
        print("[live-job] no queued job found")
        return

    job_id = job["id"]

    db.update_job(
        job_id,
        {
            "status": "running",
            "started_at": now_iso(),
            "error_message": None,
        },
    )

    try:
        result = run_job(job)

        db.update_job(
            job_id,
            {
                "status": "done",
                "finished_at": now_iso(),
                "stock_result": result["stock_result"],
                "traceability_result": result["traceability_result"],
                "error_message": None,
            },
        )

        print(f"[live-job] done job_id={job_id}")

    except Exception as exc:
        db.update_job(
            job_id,
            {
                "status": "error",
                "finished_at": now_iso(),
                "error_message": str(exc),
            },
        )

        print(f"[live-job] error job_id={job_id}: {exc}")
        raise


if __name__ == "__main__":
    main()
