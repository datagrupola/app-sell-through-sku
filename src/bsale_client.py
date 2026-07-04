import os
import time
from typing import Any, Dict, List, Optional

import requests


class BsaleClient:
    def __init__(self) -> None:
        self.base_url = os.getenv("BSALE_BASE_URL", "https://api.bsale.com.mx/v1").rstrip("/")
        self.token = os.environ["BSALE_ACCESS_TOKEN"]

        self.session = requests.Session()
        self.session.headers.update({
            "access_token": self.token,
            "Content-Type": "application/json",
        })

    def get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}/{path.lstrip('/')}"
        response = self.session.get(url, params=params, timeout=60)

        if response.status_code >= 400:
            raise RuntimeError(
                f"Bsale API error {response.status_code}: {response.text[:1000]} | url={response.url}"
            )

        time.sleep(0.15)
        return response.json()

    def get_office(self, office_id: int) -> Dict[str, Any]:
        return self.get(f"offices/{office_id}.json")

    def get_variant(self, variant_id: int) -> Dict[str, Any]:
        return self.get(f"variants/{variant_id}.json", params={"expand": "[product]"})

    def list_stocks_page(self, office_id: int, limit: int = 25, offset: int = 0) -> Dict[str, Any]:
        return self.get(
            "stocks.json",
            params={
                "officeid": office_id,
                "expand": "[office,variant]",
                "limit": limit,
                "offset": offset,
            },
        )

    def list_all_stocks(self, office_id: int, limit: int = 25) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        offset = 0

        while True:
            page = self.list_stocks_page(office_id=office_id, limit=limit, offset=offset)
            page_items = page.get("items", [])
            items.extend(page_items)

            count = int(page.get("count", 0))
            offset += limit

            print(f"[stocks] office={office_id} offset={offset} read={len(items)}/{count}")

            if offset >= count or not page_items:
                break

        return items

    def list_receptions_page(self, office_id: int, limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        return self.get(
            "stocks/receptions.json",
            params={
                "officeid": office_id,
                "expand": "[office,details]",
                "limit": limit,
                "offset": offset,
            },
        )

    def list_reception_details(
        self,
        reception_id: int,
        limit: int = 50,
        max_details: int = 300,
    ) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        offset = 0

        while True:
            page = self.get(
                f"stocks/receptions/{reception_id}/details.json",
                params={
                    "limit": limit,
                    "offset": offset,
                },
            )

            page_items = page.get("items", [])
            items.extend(page_items)

            count = int(page.get("count", 0))
            offset += limit

            if max_details > 0 and len(items) >= max_details:
                print(
                    f"[reception_details] reception={reception_id} "
                    f"truncated={len(items)}/{count} max_details={max_details}"
                )
                return items[:max_details]

            if offset >= count or not page_items:
                break

        print(f"[reception_details] reception={reception_id} read={len(items)}")
        return items
    
    def list_documents_page(
        self,
        office_id: int,
        document_type_id: int,
        start_unix: int,
        end_unix: int,
        limit: int = 50,
        offset: int = 0,
    ) -> Dict[str, Any]:
        return self.get(
            "documents.json",
            params={
                "officeid": office_id,
                "state": 0,
                "documenttypeid": document_type_id,
                "emissiondaterange": f"[{start_unix},{end_unix}]",
                "expand": "[office,document_type,details]",
                "limit": limit,
                "offset": offset,
            },
        )
    def list_consumptions_page(
        self,
        office_id: int,
        limit: int = 50,
        offset: int = 0,
    ) -> Dict[str, Any]:
        return self.get(
            "stocks/consumptions.json",
            params={
                "officeid": office_id,
                "expand": "[office,details]",
                "limit": limit,
                "offset": offset,
            },
        )

    def list_consumption_details(
        self,
        consumption_id: int,
        limit: int = 50,
        max_details: int = 300,
    ) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        offset = 0

        while True:
            page = self.get(
                f"stocks/consumptions/{consumption_id}/details.json",
                params={
                    "limit": limit,
                    "offset": offset,
                },
            )

            page_items = page.get("items", [])
            items.extend(page_items)

            count = int(page.get("count", 0))
            offset += limit

            if max_details > 0 and len(items) >= max_details:
                print(
                    f"[consumption_details] consumption={consumption_id} "
                    f"truncated={len(items)}/{count} max_details={max_details}"
                )
                return items[:max_details]

            if offset >= count or not page_items:
                break

        print(f"[consumption_details] consumption={consumption_id} read={len(items)}")
        return items