from raceattn.connectors.kalshi import KalshiConnector
from raceattn.connectors.wikipedia import WikipediaConnector

REGISTRY = {c.id: c for c in (KalshiConnector, WikipediaConnector)}
