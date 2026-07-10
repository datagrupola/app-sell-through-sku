#!/usr/bin/env python3

import argparse
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any

VERSION = "v1.0-chunk-consolidator"


def load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"No existe el archivo: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"JSON inválido: {path}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("El JSON debe ser un objeto.")
    return data


def save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def clean(value: float) -> int | float:
    return int(value) if value.is_integer() else value


def key(m: dict[str, Any]) -> tuple[Any, ...]:
    field = {
        "receptions": "reception_detail_id",
        "documents_index": "document_detail_id",
        "consumptions": "consumption_detail_id",
    }.get(m.get("source"))

    if field and m.get(field) is not None:
        return m.get("source"), m.get("office_id"), m[field]

    return (
        m.get("source"),
        m.get("office_id"),
        m.get("movement_date"),
        m.get("variant_id"),
        m.get("movement_group"),
        m.get("quantity"),
        m.get("note"),
    )


def order_key(m: dict[str, Any]) -> tuple[Any, ...]:
    source_order = {
        "receptions": 3,
        "documents_index": 2,
        "consumptions": 1,
    }
    detail_id = (
        m.get("reception_detail_id")
        or m.get("document_detail_id")
        or m.get("consumption_detail_id")
        or 0
    )
    return (
        str(m.get("movement_date") or ""),
        source_order.get(str(m.get("source") or ""), 0),
        int(detail_id or 0),
    )


def validate(data: dict[str, Any]) -> list[dict[str, Any]]:
    if data.get("status") != "complete":
        raise RuntimeError("La ejecución no está completa.")

    count = int(data.get("chunk_count") or 0)
    results = data.get("chunk_results")

    if (
        not isinstance(results, list)
        or count <= 0
        or int(data.get("completed_chunks") or 0) != count
        or len(results) != count
    ):
        raise RuntimeError("La cantidad de chunks es inválida.")

    chunks = sorted(
        results,
        key=lambda x: int(x.get("chunk_number") or 0),
    )
    query = str(data.get("query") or "").strip()
    office_id = int(data.get("office_id") or 0)
    expected_start = date.fromisoformat(
        str(data["period_start_date"])
    )

    for expected_number, chunk in enumerate(chunks, start=1):
        response = chunk.get("response")
        start = date.fromisoformat(
            str(chunk["period_start_date"])
        )
        end = date.fromisoformat(
            str(chunk["period_end_date"])
        )

        valid = (
            isinstance(response, dict)
            and int(chunk.get("chunk_number") or 0)
            == expected_number
            and start == expected_start
            and response.get("found") is True
            and str(response.get("query") or "").strip()
            == query
            and response.get("office_ids") == [office_id]
            and response.get("analysis_mode") == "period"
            and response.get("start_date") == start.isoformat()
            and response.get("end_date") == end.isoformat()
        )

        if not valid:
            raise RuntimeError(
                f"El chunk {expected_number} no coincide con el plan."
            )

        expected_start = end + timedelta(days=1)

    final_date = date.fromisoformat(str(data["period_end_date"]))

    if expected_start != final_date + timedelta(days=1):
        raise RuntimeError(
            "Los chunks no cubren completamente el periodo."
        )

    return chunks


def deduplicate(
    movements: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    unique: dict[tuple[Any, ...], dict[str, Any]] = {}

    for movement in movements:
        movement_key = key(movement)

        if (
            movement_key in unique
            and unique[movement_key] != movement
        ):
            raise RuntimeError(
                f"Movimiento duplicado conflictivo: {movement_key}"
            )

        unique[movement_key] = movement

    return sorted(
        unique.values(),
        key=order_key,
        reverse=True,
    )


def consolidate(data: dict[str, Any]) -> dict[str, Any]:
    chunks = validate(data)
    raw: list[dict[str, Any]] = []
    variant_ids: set[int] = set()
    versions: set[str] = set()
    chunk_log: list[dict[str, Any]] = []

    for chunk in chunks:
        response = chunk["response"]
        movements = response.get("movements") or []

        if not isinstance(movements, list):
            raise RuntimeError(
                f"movements inválido en chunk {chunk['chunk_number']}."
            )

        raw.extend(movements)
        variant_ids.update(
            int(x) for x in response.get("variant_ids") or []
        )

        version = str(
            response.get("function_version") or ""
        ).strip()
        if version:
            versions.add(version)

        chunk_log.append(
            {
                "chunk_number": chunk["chunk_number"],
                "period_start_date": chunk[
                    "period_start_date"
                ],
                "period_end_date": chunk["period_end_date"],
                "elapsed_seconds": chunk.get(
                    "elapsed_seconds"
                ),
                "function_version": version or None,
            }
        )

    movements = deduplicate(raw)
    receptions = [
        x for x in movements if x.get("source") == "receptions"
    ]
    consumptions = [
        x for x in movements if x.get("source") == "consumptions"
    ]
    stock_matches = (
        chunks[-1]["response"].get("stock_matches") or []
    )

    received = sum(num(x.get("quantity")) for x in receptions)
    last_received = (
        num(receptions[0].get("quantity"))
        if receptions
        else 0.0
    )
    sold = sum(
        num(x.get("quantity"))
        for x in movements
        if x.get("movement_group") == "VENTA"
    )
    returned = sum(
        num(x.get("quantity"))
        for x in movements
        if x.get("movement_group") == "DEVOLUCION"
    )
    consumed = sum(
        num(x.get("quantity")) for x in consumptions
    )
    consumed_stock = sum(
        num(x.get("quantity"))
        for x in consumptions
        if x.get("update_stock") is True
    )

    net_sold = sold - returned
    stock_outflow = net_sold + consumed_stock
    stock_actual = sum(
        num(x.get("quantity")) for x in stock_matches
    )
    stock_available = sum(
        num(x.get("quantity_available"))
        for x in stock_matches
    )
    sell_through = (
        round((net_sold / received) * 100, 2)
        if received > 0
        else None
    )
    outflow_pct = (
        round((stock_outflow / received) * 100, 2)
        if received > 0
        else None
    )
    exceeds = received > 0 and stock_outflow > received
    elapsed = [
        num(x.get("elapsed_seconds")) for x in chunks
    ]

    return {
        "found": True,
        "sell_through_found": received > 0,
        "function_version": VERSION,
        "source_function_versions": sorted(versions),
        "analysis_mode": "period",
        "query": data["query"],
        "office_ids": [data["office_id"]],
        "variant_ids": sorted(variant_ids),
        "start_date": data["period_start_date"],
        "end_date": data["period_end_date"],
        "data_policy": "closed_through_yesterday_utc",
        "stock_snapshot_policy": (
            "latest_chunk_response_live_stock"
        ),
        "stock_matches": stock_matches,
        "last_reception": (
            receptions[0] if receptions else None
        ),
        "period_receptions": receptions,
        "summary": {
            "piezas_recibidas_ultima_recepcion": (
                clean(last_received)
            ),
            "piezas_recibidas_periodo": clean(received),
            "piezas_vendidas_periodo": clean(sold),
            "piezas_devueltas_periodo": clean(returned),
            "piezas_netas_venta_periodo": clean(net_sold),
            "piezas_consumidas_ajuste_periodo": (
                clean(consumed)
            ),
            "piezas_consumidas_ajuste_stock_periodo": (
                clean(consumed_stock)
            ),
            "piezas_consumidas_sin_afectar_stock_periodo": (
                clean(consumed - consumed_stock)
            ),
            "piezas_salidas_stock_periodo": (
                clean(stock_outflow)
            ),
            "stock_actual": clean(stock_actual),
            "stock_disponible": clean(stock_available),
            "sell_through_pct": sell_through,
            "salidas_vs_recepciones_periodo_pct": (
                outflow_pct
            ),
            "advertencia_salidas_superan_recepciones_periodo": (
                exceeds
            ),
            "nota_trazabilidad": (
                "Las salidas superan las entradas del periodo; "
                "se requiere FIFO para atribuirlas a recepciones."
                if exceeds
                else None
            ),
        },
        "movements": movements,
        "consolidation": {
            "status": "complete",
            "chunk_count": data["chunk_count"],
            "completed_chunks": data["completed_chunks"],
            "chunk_days": data["chunk_days"],
            "input_movement_count": len(raw),
            "deduplicated_movement_count": len(movements),
            "duplicate_movement_count": (
                len(raw) - len(movements)
            ),
            "total_chunk_elapsed_seconds": round(
                sum(elapsed), 2
            ),
            "max_chunk_elapsed_seconds": round(
                max(elapsed, default=0.0), 2
            ),
            "chunks": chunk_log,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Consolida resultados de sell-through."
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    result = consolidate(load(Path(args.input)))
    output = Path(args.output)
    save(output, result)

    print(
        json.dumps(
            {
                "status": "complete",
                "output": str(output),
                "query": result["query"],
                "office_ids": result["office_ids"],
                "chunk_count": result[
                    "consolidation"
                ]["chunk_count"],
                "movement_count": len(
                    result["movements"]
                ),
                "reception_count": len(
                    result["period_receptions"]
                ),
                "sell_through_pct": result[
                    "summary"
                ]["sell_through_pct"],
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
