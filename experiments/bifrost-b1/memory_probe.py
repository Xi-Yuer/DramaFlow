"""只读自建 Gateway 的内存；仅返回合成 key 是否仍可找到，不输出内存内容。"""

import json
import sys

values = json.load(sys.stdin)
patterns = {key: value.encode() for key, value in values.items()}
found = {key: False for key in patterns}
scanned = 0
limit = 256 * 1024 * 1024
try:
    with open("/proc/1/mem", "rb", buffering=0) as memory:
        for line in open("/proc/1/maps"):
            fields = line.split()
            if "r" not in fields[1] or "w" not in fields[1] or (len(fields) > 5 and not fields[5].startswith("[")):
                continue
            start, end = [int(x, 16) for x in fields[0].split("-")]
            tail = b""
            position = start
            while position < end and scanned < limit:
                size = min(1024 * 1024, end - position, limit - scanned)
                try:
                    memory.seek(position)
                    chunk = memory.read(size)
                except OSError:
                    break
                scanned += len(chunk)
                position += size
                data = tail + chunk
                for key, pattern in patterns.items():
                    found[key] = found[key] or pattern in data
                tail = data[-256:]
            if scanned >= limit:
                break
    print(json.dumps({"supported": True, "scannedBytes": scanned, "scanLimitBytes": limit, "credentialPresent": found}))
except (OSError, PermissionError) as error:
    print(json.dumps({"supported": False, "errorType": type(error).__name__}))
