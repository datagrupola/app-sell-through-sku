#!/usr/bin/env python3

import argparse
import json
from datetime import date, timedelta


def parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f"Fecha inválida: {value}. Usa YYYY-MM-DD."
        ) from exc


def build_chunks(
    start_date: date,
    end_date: date,
    chunk_days: int = 30,
) -> list[dict[str, object]]:
    if start_date > end_date:
        raise ValueError("La fecha inicial no puede ser posterior a la final.")

    if not 1 <= chunk_days <= 30:
        raise ValueError("chunk_days debe estar entre 1 y 30.")

    chunks: list[dict[str, object]] = []
    cursor = start_date
    chunk_number = 1

    while cursor <= end_date:
        chunk_end = min(
            cursor + timedelta(days=chunk_days - 1),
            end_date,
        )

        chunks.append(
            {
                "chunk_number": chunk_number,
                "period_start_date": cursor.isoformat(),
                "period_end_date": chunk_end.isoformat(),
                "days": (chunk_end - cursor).days + 1,
            }
        )

        cursor = chunk_end + timedelta(days=1)
        chunk_number += 1

    return chunks


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Genera ventanas inclusivas para sell-through."
    )
    parser.add_argument("--start-date", required=True, type=parse_date)
    parser.add_argument("--end-date", required=True, type=parse_date)
    parser.add_argument("--chunk-days", type=int, default=30)
    args = parser.parse_args()

    chunks = build_chunks(
        args.start_date,
        args.end_date,
        args.chunk_days,
    )

    output = {
        "period_start_date": args.start_date.isoformat(),
        "period_end_date": args.end_date.isoformat(),
        "chunk_days": args.chunk_days,
        "chunk_count": len(chunks),
        "total_days": (
            args.end_date - args.start_date
        ).days + 1,
        "chunks": chunks,
    }

    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
