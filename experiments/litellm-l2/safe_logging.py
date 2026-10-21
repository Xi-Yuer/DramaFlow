"""验证用 allowlist 日志格式；不读取 message、args、exc_info 或 stack_info。"""

import datetime
import json
import logging


class AllowlistFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "time": datetime.datetime.fromtimestamp(record.created, datetime.timezone.utc).isoformat(),
            "severity": record.levelname if record.levelname in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"} else "UNKNOWN",
            "component": "litellm_gateway",
            "event": "gateway_diagnostic",
        })
