from raceattn.connectors.bluesky import BlueskyConnector
from raceattn.connectors.kalshi import KalshiConnector, KalshiTradesConnector
from raceattn.connectors.news import (GdeltConnector, GuardianConnector, ManualNewsConnector, MediaCloudConnector,
                                      NytConnector)
from raceattn.connectors.wikipedia import WikipediaConnector
from raceattn.connectors.x import XConnector

REGISTRY = {c.id: c for c in (KalshiConnector, KalshiTradesConnector, WikipediaConnector, XConnector,
                              MediaCloudConnector, GuardianConnector, NytConnector, ManualNewsConnector,
                              GdeltConnector, BlueskyConnector)}
