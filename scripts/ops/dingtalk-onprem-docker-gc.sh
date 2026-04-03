#!/bin/bash

set -euo pipefail

SSH_USER_HOST="${SSH_USER_HOST:-mainuser@142.171.239.56}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/metasheet2_deploy}"
JSON_OUTPUT="${JSON_OUTPUT:-false}"
REMOTE_SELF="${REMOTE_SELF:-false}"

REMOTE_LOG_DIR="${REMOTE_LOG_DIR:-/home/mainuser/docker-gc-runs}"
IMAGE_UNTIL="${IMAGE_UNTIL:-168h}"
CONTAINER_UNTIL="${CONTAINER_UNTIL:-168h}"
NETWORK_UNTIL="${NETWORK_UNTIL:-168h}"
BUILDER_UNUSED_FOR="${BUILDER_UNUSED_FOR:-168h}"

ssh_cmd() {
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no "${SSH_USER_HOST}" "$@"
}

remote_main() {
  mkdir -p "${REMOTE_LOG_DIR}"

  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local report_file="${REMOTE_LOG_DIR}/docker-gc-${timestamp}.json"
  local before_df after_df before_images after_images before_dangling after_dangling running_containers
  local image_output container_output network_output builder_output
  local image_output_b64 container_output_b64 network_output_b64 builder_output_b64

  before_df="$(df -P / | awk 'NR==2 {print $2" "$3" "$4" "$5}')"
  before_images="$(docker images -q | wc -l | tr -d ' ')"
  before_dangling="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^<none>:<none>$' || true)"
  running_containers="$(docker ps -q | wc -l | tr -d ' ')"

  image_output="$(docker image prune -a -f --filter "until=${IMAGE_UNTIL}" 2>&1)"
  container_output="$(docker container prune -f --filter "until=${CONTAINER_UNTIL}" 2>&1)"
  network_output="$(docker network prune -f --filter "until=${NETWORK_UNTIL}" 2>&1)"
  builder_output="$(docker builder prune -a -f --filter "unused-for=${BUILDER_UNUSED_FOR}" 2>&1)"

  after_df="$(df -P / | awk 'NR==2 {print $2" "$3" "$4" "$5}')"
  after_images="$(docker images -q | wc -l | tr -d ' ')"
  after_dangling="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^<none>:<none>$' || true)"

  image_output_b64="$(printf '%s' "${image_output}" | base64 | tr -d '\n')"
  container_output_b64="$(printf '%s' "${container_output}" | base64 | tr -d '\n')"
  network_output_b64="$(printf '%s' "${network_output}" | base64 | tr -d '\n')"
  builder_output_b64="$(printf '%s' "${builder_output}" | base64 | tr -d '\n')"

  BEFORE_DF="${before_df}" \
  AFTER_DF="${after_df}" \
  BEFORE_IMAGES="${before_images}" \
  AFTER_IMAGES="${after_images}" \
  BEFORE_DANGLING="${before_dangling}" \
  AFTER_DANGLING="${after_dangling}" \
  RUNNING_CONTAINERS="${running_containers}" \
  REPORT_FILE="${report_file}" \
  TIMESTAMP_INPUT="${timestamp}" \
  IMAGE_UNTIL_INPUT="${IMAGE_UNTIL}" \
  CONTAINER_UNTIL_INPUT="${CONTAINER_UNTIL}" \
  NETWORK_UNTIL_INPUT="${NETWORK_UNTIL}" \
  BUILDER_UNUSED_FOR_INPUT="${BUILDER_UNUSED_FOR}" \
  IMAGE_OUTPUT_B64="${image_output_b64}" \
  CONTAINER_OUTPUT_B64="${container_output_b64}" \
  NETWORK_OUTPUT_B64="${network_output_b64}" \
  BUILDER_OUTPUT_B64="${builder_output_b64}" \
  JSON_OUTPUT_INPUT="${JSON_OUTPUT}" \
  python3 - <<'EOF'
import base64
import json
import os
from pathlib import Path


def parse_df(text: str) -> dict:
    parts = text.split()
    if len(parts) != 4:
        return {
            "totalKBlocks": 0,
            "usedKBlocks": 0,
            "availableKBlocks": 0,
            "usePercent": 100,
        }
    total, used, avail, percent = parts
    try:
        return {
            "totalKBlocks": int(total),
            "usedKBlocks": int(used),
            "availableKBlocks": int(avail),
            "usePercent": int(percent.rstrip("%")),
        }
    except ValueError:
        return {
            "totalKBlocks": 0,
            "usedKBlocks": 0,
            "availableKBlocks": 0,
            "usePercent": 100,
        }


def parse_prune_output(text: str) -> dict:
    reclaimed = ""
    deleted = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("Deleted Images:") or line.startswith("Deleted Containers:") or line.startswith("Deleted Networks:") or line.startswith("Deleted build cache objects:"):
            continue
        if line.startswith("deleted:"):
            deleted.append(line[len("deleted:"):].strip())
            continue
        if line.startswith("untagged:"):
            deleted.append(line[len("untagged:"):].strip())
            continue
        if line.startswith("deleted build cache object:"):
            deleted.append(line[len("deleted build cache object:"):].strip())
            continue
        if line.startswith("Total reclaimed space:"):
            reclaimed = line.split(":", 1)[1].strip()
    return {
        "deletedCount": len(deleted),
        "sampleDeleted": deleted[:10],
        "reclaimed": reclaimed,
        "raw": text,
    }


image_output = base64.b64decode(os.environ["IMAGE_OUTPUT_B64"]).decode()
container_output = base64.b64decode(os.environ["CONTAINER_OUTPUT_B64"]).decode()
network_output = base64.b64decode(os.environ["NETWORK_OUTPUT_B64"]).decode()
builder_output = base64.b64decode(os.environ["BUILDER_OUTPUT_B64"]).decode()

report = {
    "checkedAt": os.environ["TIMESTAMP_INPUT"],
    "target": "remote-self",
    "thresholds": {
        "imageUntil": os.environ["IMAGE_UNTIL_INPUT"],
        "containerUntil": os.environ["CONTAINER_UNTIL_INPUT"],
        "networkUntil": os.environ["NETWORK_UNTIL_INPUT"],
        "builderUnusedFor": os.environ["BUILDER_UNUSED_FOR_INPUT"],
    },
    "disk": {
        "before": parse_df(os.environ["BEFORE_DF"]),
        "after": parse_df(os.environ["AFTER_DF"]),
    },
    "images": {
        "beforeCount": int(os.environ["BEFORE_IMAGES"]),
        "afterCount": int(os.environ["AFTER_IMAGES"]),
        "beforeDanglingCount": int(os.environ["BEFORE_DANGLING"]),
        "afterDanglingCount": int(os.environ["AFTER_DANGLING"]),
    },
    "runningContainers": int(os.environ["RUNNING_CONTAINERS"]),
    "prune": {
        "images": parse_prune_output(image_output),
        "containers": parse_prune_output(container_output),
        "networks": parse_prune_output(network_output),
        "builder": parse_prune_output(builder_output),
    },
}

report["disk"]["freedKBlocks"] = report["disk"]["after"]["availableKBlocks"] - report["disk"]["before"]["availableKBlocks"]
report["images"]["removedCount"] = report["images"]["beforeCount"] - report["images"]["afterCount"]
report["images"]["danglingRemovedCount"] = report["images"]["beforeDanglingCount"] - report["images"]["afterDanglingCount"]
report["ok"] = report["disk"]["after"]["availableKBlocks"] > 0 and report["runningContainers"] > 0

report_path = Path(os.environ["REPORT_FILE"])
report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

if os.environ["JSON_OUTPUT_INPUT"] == "true":
    print(json.dumps(report, ensure_ascii=False, indent=2))
else:
    print(f"[onprem-docker-gc] checkedAt={report['checkedAt']}")
    print(f"[onprem-docker-gc] root.use.before={report['disk']['before']['usePercent']}% after={report['disk']['after']['usePercent']}% freedKBlocks={report['disk']['freedKBlocks']}")
    print(f"[onprem-docker-gc] images.before={report['images']['beforeCount']} after={report['images']['afterCount']} removed={report['images']['removedCount']}")
    print(f"[onprem-docker-gc] dangling.before={report['images']['beforeDanglingCount']} after={report['images']['afterDanglingCount']}")
    print(f"[onprem-docker-gc] builder.reclaimed={report['prune']['builder']['reclaimed']}")
    print(f"[onprem-docker-gc] report={report_path}")
    print(f"[onprem-docker-gc] ok={str(report['ok']).lower()}")
EOF
}

local_main() {
  local self_path
  self_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  ssh -i "${SSH_KEY}" -o BatchMode=yes -o StrictHostKeyChecking=no \
    "${SSH_USER_HOST}" \
    "REMOTE_SELF=true JSON_OUTPUT='${JSON_OUTPUT}' REMOTE_LOG_DIR='${REMOTE_LOG_DIR}' IMAGE_UNTIL='${IMAGE_UNTIL}' CONTAINER_UNTIL='${CONTAINER_UNTIL}' NETWORK_UNTIL='${NETWORK_UNTIL}' BUILDER_UNUSED_FOR='${BUILDER_UNUSED_FOR}' bash -s --" < "${self_path}"
}

if [ "${REMOTE_SELF}" = "true" ]; then
  remote_main
else
  local_main
fi
