import os
import time
from typing import Any, Dict, List, Optional

import requests


class SupabaseRestClient:
    def __init__(self) -> None:
        self.base_url = os.environ["SUPABASE_URL"].rstrip("/")
        self.service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

        self.session = requests.Session()
        self.session.headers.update({
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": "application/json",
        })

    def upsert(
        self,
        table: str,
        rows: List[Dict[str, Any]],
        on_conflict: Optional[str] = None,
        chunk_size: int = 200,
    ) -> None:
        if not rows:
            return

        total = len(rows)

        for start in range(0, total, chunk_size):
            chunk = rows[start:start + chunk_size]

            url = f"{self.base_url}/rest/v1/{table}"
            params = {}

            if on_conflict:
                params["on_conflict"] = on_conflict

            headers = {
                "Prefer": "resolution=merge-duplicates,return=minimal"
            }

            response = self.session.post(
                url,
                params=params,
                headers=headers,
                json=chunk,
                timeout=180,
            )

            if response.status_code >= 400:
                raise RuntimeError(
                    f"Supabase upsert error {response.status_code} on {table}: "
                    f"{response.text[:2000]}"
                )

            print(
                f"[supabase] upsert table={table} "
                f"rows={start + len(chunk)}/{total}"
            )

            time.sleep(0.05)

    def insert_ignore(
        self,
        table: str,
        rows: List[Dict[str, Any]],
        on_conflict: Optional[str] = None,
        chunk_size: int = 200,
    ) -> None:
        if not rows:
            return

        total = len(rows)

        for start in range(0, total, chunk_size):
            chunk = rows[start:start + chunk_size]

            url = f"{self.base_url}/rest/v1/{table}"
            params = {}

            if on_conflict:
                params["on_conflict"] = on_conflict

            headers = {
                "Prefer": "resolution=ignore-duplicates,return=minimal"
            }

            response = self.session.post(
                url,
                params=params,
                headers=headers,
                json=chunk,
                timeout=180,
            )

            if response.status_code >= 400:
                raise RuntimeError(
                    f"Supabase insert_ignore error {response.status_code} on {table}: "
                    f"{response.text[:2000]}"
                )

            print(
                f"[supabase] insert_ignore table={table} "
                f"rows={start + len(chunk)}/{total}"
            )

    def upsert_one(
        self,
        table: str,
        row: Dict[str, Any],
        on_conflict: Optional[str] = None,
    ) -> None:
        self.upsert(
            table=table,
            rows=[row],
            on_conflict=on_conflict,
            chunk_size=1,
        )
    