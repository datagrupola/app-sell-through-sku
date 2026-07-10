#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


CONFLICT_COLUMNS = (
    "query_norm,"
    "office_id,"
    "analysis_mode,"
    "start_date,"
    "end_date"
)


def load_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"No existe el archivo de entrada: {path}"
        ) from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"El archivo no contiene JSON válido: {path}"
        ) from exc

    if not isinstance(data, dict):
        raise RuntimeError(
            "El resultado consolidado debe ser un objeto JSON."
        )

    return data


def required_text(
    data: dict[str, Any],
    field: str,
) -> str:
    value = data.get(field)

    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(
            f"Campo requerido inválido: {field}"
        )

    return value.strip()


def numeric(
    value: Any,
    field: str,
) -> int | float:
    if isinstance(value, bool):
        raise RuntimeError(
            f"Campo numérico inválido: {field}"
        )

    if not isinstance(value, (int, float)):
        raise RuntimeError(
            f"Campo numérico inválido: {field}"
        )

    return value


def parse_run_id(value: str | None) -> int | None:
    if value is None or not value.strip():
        return None

    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(
            "GITHUB_RUN_ID debe ser un entero."
        ) from exc


def build_row(
    result: dict[str, Any],
    run_id: int | None,
) -> dict[str, Any]:
    if result.get("found") is not True:
        raise RuntimeError(
            "El resultado consolidado no encontró el SKU."
        )

    consolidation = result.get("consolidation")
    if not isinstance(consolidation, dict):
        raise RuntimeError(
            "Falta el bloque consolidation."
        )

    if consolidation.get("status") != "complete":
        raise RuntimeError(
            "Solo se persisten consolidaciones completas."
        )

    office_ids = result.get("office_ids")
    if (
        not isinstance(office_ids, list)
        or len(office_ids) != 1
        or isinstance(office_ids[0], bool)
        or not isinstance(office_ids[0], int)
    ):
        raise RuntimeError(
            "El resultado debe contener exactamente un office_id."
        )

    summary = result.get("summary")
    if not isinstance(summary, dict):
        raise RuntimeError(
            "Falta el bloque summary."
        )

    stock_matches = result.get("stock_matches", [])
    if not isinstance(stock_matches, list):
        raise RuntimeError(
            "stock_matches debe ser una lista."
        )

    stock_reservado: int | float = 0

    for index, stock in enumerate(stock_matches):
        if not isinstance(stock, dict):
            raise RuntimeError(
                f"stock_matches[{index}] debe ser un objeto."
            )

        stock_reservado += numeric(
            stock.get("quantity_reserved", 0),
            f"stock_matches[{index}].quantity_reserved",
        )

    last_reception = result.get("last_reception")
    ultima_recepcion_fecha: str | None = None

    if last_reception is not None:
        if not isinstance(last_reception, dict):
            raise RuntimeError(
                "last_reception debe ser un objeto o null."
            )

        movement_date = last_reception.get("movement_date")

        if movement_date is not None:
            if not isinstance(movement_date, str):
                raise RuntimeError(
                    "last_reception.movement_date es inválido."
                )

            ultima_recepcion_fecha = movement_date

    computed_at = datetime.now(timezone.utc)

    return {
        "query": required_text(result, "query"),
        "office_id": office_ids[0],
        "analysis_mode": required_text(
            result,
            "analysis_mode",
        ),
        "start_date": required_text(
            result,
            "start_date",
        ),
        "end_date": required_text(
            result,
            "end_date",
        ),
        "function_version": result.get(
            "function_version"
        ),
        "source": "github_actions",
        "source_run_id": run_id,
        "piezas_recibidas": numeric(
            summary.get(
                "piezas_recibidas_periodo",
                0,
            ),
            "summary.piezas_recibidas_periodo",
        ),
        "piezas_netas_vendidas": numeric(
            summary.get(
                "piezas_netas_venta_periodo",
                0,
            ),
            "summary.piezas_netas_venta_periodo",
        ),
        "sell_through_pct": numeric(
            summary.get("sell_through_pct", 0),
            "summary.sell_through_pct",
        ),
        "stock_actual": numeric(
            summary.get("stock_actual", 0),
            "summary.stock_actual",
        ),
        "stock_reservado": stock_reservado,
        "stock_disponible": numeric(
            summary.get("stock_disponible", 0),
            "summary.stock_disponible",
        ),
        "ultima_recepcion_fecha": (
            ultima_recepcion_fecha
        ),
        "summary": summary,
        "result": result,
        "computed_at": computed_at.isoformat(),
        "expires_at": (
            computed_at + timedelta(hours=24)
        ).isoformat(),
    }


def persist(
    row: dict[str, Any],
    supabase_url: str,
    secret_key: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    query_string = urlencode(
        {"on_conflict": CONFLICT_COLUMNS}
    )

    endpoint = (
        f"{supabase_url.rstrip('/')}"
        "/rest/v1/sell_through_cache"
        f"?{query_string}"
    )

    headers = {
        "apikey": secret_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Prefer": (
            "resolution=merge-duplicates,"
            "return=representation"
        ),
    }

    # Compatibilidad con la clave JWT service_role antigua.
    if secret_key.startswith("eyJ"):
        headers["Authorization"] = (
            f"Bearer {secret_key}"
        )

    request = Request(
        endpoint,
        data=json.dumps(
            row,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urlopen(
            request,
            timeout=timeout_seconds,
        ) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode(
            "utf-8",
            errors="replace",
        )
        raise RuntimeError(
            "Supabase rechazó el upsert "
            f"con HTTP {exc.code}: {body}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(
            f"No fue posible conectar con Supabase: {exc}"
        ) from exc

    try:
        response_data = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "Supabase devolvió una respuesta no JSON."
        ) from exc

    if (
        not isinstance(response_data, list)
        or len(response_data) != 1
        or not isinstance(response_data[0], dict)
    ):
        raise RuntimeError(
            "Supabase no devolvió exactamente una fila."
        )

    return response_data[0]


def purge_expired(
    supabase_url: str,
    secret_key: str,
    timeout_seconds: int,
) -> int:
    endpoint = (
        f"{supabase_url.rstrip('/')}"
        "/rest/v1/rpc/"
        "purge_expired_sell_through_cache"
    )

    headers = {
        "apikey": secret_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    if secret_key.startswith("eyJ"):
        headers["Authorization"] = (
            f"Bearer {secret_key}"
        )

    request = Request(
        endpoint,
        data=b"{}",
        headers=headers,
        method="POST",
    )

    try:
        with urlopen(
            request,
            timeout=timeout_seconds,
        ) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        body = exc.read().decode(
            "utf-8",
            errors="replace",
        )
        raise RuntimeError(
            "Supabase rechazó la limpieza de caché "
            f"con HTTP {exc.code}: {body}"
        ) from exc
    except URLError as exc:
        raise RuntimeError(
            "No fue posible limpiar la caché "
            f"de Supabase: {exc}"
        ) from exc

    try:
        deleted_count = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "Supabase devolvió una respuesta inválida "
            "al limpiar la caché."
        ) from exc

    if (
        isinstance(deleted_count, bool)
        or not isinstance(deleted_count, int)
    ):
        raise RuntimeError(
            "La limpieza de caché no devolvió "
            "un conteo entero."
        )

    return deleted_count


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Guarda temporalmente un resultado "
            "consolidado de sell-through en Supabase."
        )
    )
    parser.add_argument("--input", required=True)
    parser.add_argument(
        "--supabase-url",
        default=os.environ.get("SUPABASE_URL"),
    )
    parser.add_argument(
        "--secret-key",
        default=os.environ.get(
            "SUPABASE_SECRET_KEY"
        ),
    )
    parser.add_argument(
        "--run-id",
        default=os.environ.get("GITHUB_RUN_ID"),
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=60,
    )
    args = parser.parse_args()

    if not args.supabase_url:
        raise RuntimeError(
            "Falta SUPABASE_URL."
        )

    if not args.secret_key:
        raise RuntimeError(
            "Falta SUPABASE_SECRET_KEY."
        )

    result = load_json(Path(args.input))
    row = build_row(
        result,
        parse_run_id(args.run_id),
    )

    purged_expired_rows = purge_expired(
        supabase_url=args.supabase_url,
        secret_key=args.secret_key,
        timeout_seconds=args.timeout_seconds,
    )

    persisted = persist(
        row=row,
        supabase_url=args.supabase_url,
        secret_key=args.secret_key,
        timeout_seconds=args.timeout_seconds,
    )

    print(
        json.dumps(
            {
                "status": "cached",
                "purged_expired_rows": (
                    purged_expired_rows
                ),
                "id": persisted.get("id"),
                "query": persisted.get("query"),
                "office_id": persisted.get(
                    "office_id"
                ),
                "start_date": persisted.get(
                    "start_date"
                ),
                "end_date": persisted.get(
                    "end_date"
                ),
                "sell_through_pct": persisted.get(
                    "sell_through_pct"
                ),
                "source_run_id": persisted.get(
                    "source_run_id"
                ),
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(
            f"ERROR: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(1)
