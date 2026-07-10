#!/usr/bin/env python3

import argparse
import json
import os
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from sell_through_chunk_plan import build_chunks


DEFAULT_FUNCTION_NAME = "calculate-sell-through-chunk-v1"
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Fecha inválida: {value}. Usa YYYY-MM-DD."
        ) from exc


def required_env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value

    raise RuntimeError(
        "Falta una variable de entorno requerida. "
        f"Define alguna de: {', '.join(names)}"
    )


def post_json(
    url: str,
    payload: dict[str, Any],
    api_key: str,
    timeout_seconds: int,
    max_attempts: int,
) -> dict[str, Any]:
    encoded_payload = json.dumps(payload).encode("utf-8")

    for attempt in range(1, max_attempts + 1):
        request = Request(
            url,
            data=encoded_payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "apikey": api_key,
                "Content-Type": "application/json",
            },
        )

        try:
            with urlopen(request, timeout=timeout_seconds) as response:
                body = response.read().decode("utf-8")
                result = json.loads(body)

                if not isinstance(result, dict):
                    raise RuntimeError(
                        "La Edge Function no devolvió un objeto JSON."
                    )

                return result

        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            retryable = exc.code in RETRYABLE_STATUS_CODES

            if not retryable or attempt == max_attempts:
                raise RuntimeError(
                    f"Edge Function respondió HTTP {exc.code}: "
                    f"{body[:1000]}"
                ) from exc

            delay_seconds = 5 * attempt
            print(
                f"Intento {attempt}/{max_attempts} falló con "
                f"HTTP {exc.code}. Reintentando en "
                f"{delay_seconds}s...",
                file=sys.stderr,
            )
            time.sleep(delay_seconds)

        except URLError as exc:
            if attempt == max_attempts:
                raise RuntimeError(
                    f"No se pudo conectar con la Edge Function: {exc}"
                ) from exc

            delay_seconds = 5 * attempt
            print(
                f"Error de conexión. Reintentando en "
                f"{delay_seconds}s...",
                file=sys.stderr,
            )
            time.sleep(delay_seconds)

        except TimeoutError as exc:
            if attempt == max_attempts:
                raise RuntimeError(
                    "La Edge Function agotó el tiempo de espera."
                ) from exc

            delay_seconds = 5 * attempt
            print(
                f"Timeout. Reintentando en {delay_seconds}s...",
                file=sys.stderr,
            )
            time.sleep(delay_seconds)

    raise RuntimeError("No fue posible completar la solicitud.")


def validate_chunk_response(
    response: dict[str, Any],
    office_id: int,
    chunk: dict[str, Any],
) -> None:
    returned_offices = response.get("office_ids")

    if returned_offices != [office_id]:
        raise RuntimeError(
            "La respuesta no corresponde a la sucursal solicitada: "
            f"{returned_offices}"
        )

    if response.get("analysis_mode") != "period":
        raise RuntimeError(
            "La respuesta no corresponde a analysis_mode=period."
        )

    if response.get("start_date") != chunk["period_start_date"]:
        raise RuntimeError(
            "La fecha inicial de la respuesta no coincide con el chunk."
        )

    if response.get("end_date") != chunk["period_end_date"]:
        raise RuntimeError(
            "La fecha final de la respuesta no coincide con el chunk."
        )


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Ejecuta sell-through por ventanas secuenciales "
            "de máximo 30 días."
        )
    )
    parser.add_argument("--query", required=True)
    parser.add_argument("--office-id", required=True, type=int)
    parser.add_argument("--start-date", required=True, type=parse_date)
    parser.add_argument("--end-date", required=True, type=parse_date)
    parser.add_argument("--chunk-days", type=int, default=30)
    parser.add_argument("--pause-seconds", type=float, default=10)
    parser.add_argument("--timeout-seconds", type=int, default=150)
    parser.add_argument("--max-attempts", type=int, default=4)
    parser.add_argument(
        "--function-name",
        default=DEFAULT_FUNCTION_NAME,
    )
    parser.add_argument(
        "--output",
        default="artifacts/sell-through/chunk-results.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Solo muestra el plan; no invoca Supabase.",
    )
    args = parser.parse_args()

    query = args.query.strip()

    if not query:
        raise ValueError("query no puede estar vacío.")

    if args.office_id <= 0:
        raise ValueError("office-id debe ser mayor que cero.")

    chunks = build_chunks(
        args.start_date,
        args.end_date,
        args.chunk_days,
    )

    plan = {
        "query": query,
        "office_id": args.office_id,
        "period_start_date": args.start_date.isoformat(),
        "period_end_date": args.end_date.isoformat(),
        "chunk_days": args.chunk_days,
        "chunk_count": len(chunks),
        "chunks": chunks,
    }

    if args.dry_run:
        print(json.dumps(plan, indent=2, ensure_ascii=False))
        return

    supabase_url = required_env("SUPABASE_URL").rstrip("/")
    function_key = required_env(
        "SUPABASE_FUNCTION_KEY",
        "SUPABASE_ANON_KEY",
    )

    function_url = (
        f"{supabase_url}/functions/v1/{args.function_name}"
    )

    execution: dict[str, Any] = {
        "status": "running",
        **plan,
        "function_name": args.function_name,
        "completed_chunks": 0,
        "chunk_results": [],
    }

    output_path = Path(args.output)

    for index, chunk in enumerate(chunks):
        chunk_number = int(chunk["chunk_number"])

        payload = {
            "query": query,
            "office_ids": [args.office_id],
            "analysis_mode": "period",
            "period_start_date": chunk["period_start_date"],
            "period_end_date": chunk["period_end_date"],
        }

        print(
            f"Ejecutando chunk {chunk_number}/{len(chunks)}: "
            f"{chunk['period_start_date']} → "
            f"{chunk['period_end_date']}",
            file=sys.stderr,
        )

        started_at = time.monotonic()

        response = post_json(
            function_url,
            payload,
            function_key,
            args.timeout_seconds,
            args.max_attempts,
        )

        validate_chunk_response(
            response,
            args.office_id,
            chunk,
        )

        elapsed_seconds = round(
            time.monotonic() - started_at,
            2,
        )

        execution["chunk_results"].append(
            {
                **chunk,
                "elapsed_seconds": elapsed_seconds,
                "function_version": response.get(
                    "function_version"
                ),
                "response": response,
            }
        )
        execution["completed_chunks"] = chunk_number

        # Checkpoint después de cada chunk.
        write_json(output_path, execution)

        print(
            f"Chunk {chunk_number} completado en "
            f"{elapsed_seconds}s.",
            file=sys.stderr,
        )

        if index < len(chunks) - 1:
            time.sleep(args.pause_seconds)

    execution["status"] = "complete"
    write_json(output_path, execution)

    print(
        json.dumps(
            {
                "status": execution["status"],
                "completed_chunks": execution[
                    "completed_chunks"
                ],
                "output": str(output_path),
            },
            indent=2,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
