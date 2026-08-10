#!/bin/sh
# 抓取最新台风数据，有变化时提交并推送（Pages 自动跟随重新发布）
cd "$(dirname "$0")/.." || exit 1
python3 fetcher/fetch.py || exit 1
python3 fetcher/fetch_metar.py || true
python3 fetcher/fetch_wind.py || true
python3 fetcher/fetch_fnv3.py || true
python3 fetcher/build_impact.py || true
python3 fetcher/build_consensus.py || true   # 吃 docs/data/verify/（fetch.py 产出），云端同样可跑
python3 fetcher/fetch_himawari.py || true
python3 fetcher/fetch_warnings.py || true      # 官方预警（CMA，经 WMO CAP 公开中继）
# 降雨底座变了就重算分位表（前端标定用；底座没变时是空操作）
python3 fetcher/build_rain_percentile.py || true
if ! git diff --quiet docs/data; then
  git add docs/data
  git commit --quiet -m "data: 自动更新台风数据 $(date -u +%Y-%m-%dT%H:%MZ)"
  git push --quiet
  echo "pushed data update"
else
  echo "no data change"
fi
