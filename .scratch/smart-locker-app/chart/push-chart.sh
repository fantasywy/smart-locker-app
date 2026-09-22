#!/usr/bin/env bash
# Wayfinder charting push — 把 .scratch/smart-locker-app/chart/*.md 落成 GitHub issues。
# 步骤：labels -> map -> 13 children（native sub-issues）-> blocking edges（native dependencies）
set -uo pipefail

GH=/home/fantasywy/.local/bin/gh
REPO=fantasywy/smart-locker-app
DIR=/home/fantasywy/codes/WeChatProjects/smart-locker-app/.scratch/smart-locker-app/chart
OUT="$DIR/created.map"
: > "$OUT"

echo "### 1. labels"
create_label() {
  "$GH" label create "$1" -R "$REPO" --color "$2" --description "$3" --force >/dev/null \
    && echo "  ok   $1" || echo "  FAIL $1"
}
create_label "wayfinder:map"       5319e7 "Wayfinder map：chart 本体，承载 Notes / Decisions / Fog"
create_label "wayfinder:research"  0e8a16 "Wayfinder research：AFK 事实核查"
create_label "wayfinder:grilling"  1d76db "Wayfinder grilling：HITL 决策裁决"
create_label "wayfinder:prototype" d93f0b "Wayfinder prototype：用原型回答问题"
create_label "wayfinder:task"      fbca04 "Wayfinder task：产出物明确的执行项"

echo "### 2. map"
MAP_URL=$("$GH" issue create -R "$REPO" \
  --title "小程序 C 端设计规格（map）" \
  --label wayfinder:map \
  --body-file "$DIR/00-map.md") || { echo "map 创建失败"; exit 1; }
MAP=${MAP_URL##*/}
echo "  map = #$MAP"
echo "map $MAP" >> "$OUT"

echo "### 3. children"
create_child() {
  local id="$1" title="$2" label="$3" body="$4"
  local url num dbid
  url=$("$GH" issue create -R "$REPO" \
    --title "$id — $title" \
    --label "$label" \
    --body-file "$DIR/$body") || { echo "  FAIL $id (create)"; return 1; }
  num=${url##*/}
  dbid=$("$GH" api "repos/$REPO/issues/$num" --jq .id) || { echo "  FAIL $id (dbid)"; return 1; }
  if "$GH" api --method POST "repos/$REPO/issues/$MAP/sub_issues" -F sub_issue_id="$dbid" >/dev/null 2>&1; then
    echo "  ok   $id -> #$num (sub-issue of #$MAP)"
  else
    echo "  WARN $id -> #$num 创建成功但挂 sub-issue 失败"
  fi
  echo "$id $num $dbid" >> "$OUT"
}
create_child R1 "C 端接口映射底稿"                        wayfinder:research  R1.md
create_child R2 "取件码与中控屏「扫码」tab 的真实语义"     wayfinder:research  R2.md
create_child R3 "三个未闭合口径在后端文档里的确切表述"     wayfinder:research  R3.md
create_child D1 "入口与身份模型"                          wayfinder:grilling  D1.md
create_child D2 "小程序 × 中控屏职责边界：取件码怎么流转"  wayfinder:grilling  D2.md
create_child D3 "订单首页如何表达未存入 / 使用中 / 异常"   wayfinder:grilling  D3.md
create_child D4 "黑名单与低信用分的降级体验"               wayfinder:grilling  D4.md
create_child D5 "预约时段选择与占位窗口的用户表达"         wayfinder:grilling  D5.md
create_child D6 "支付的一期形态与异常分支"                 wayfinder:grilling  D6.md
create_child D7 "技术栈与工程形态"                        wayfinder:grilling  D7.md
create_child P1 "「等待关门」等待态与指令失败重试"         wayfinder:prototype P1.md
create_child T1 "C 端中文文案与状态口径表"                 wayfinder:task      T1.md
create_child T2 "小程序视觉语言：色调层与 ink 规则移植"    wayfinder:task      T2.md

echo "### 4. blocking edges"
num_of() { awk -v k="$1" '$1==k {print $2}' "$OUT"; }
dbi_of() { awk -v k="$1" '$1==k {print $3}' "$OUT"; }
EDGE_FAIL=0
wire() {
  local blocker="$1" child="$2"
  local bid cnum
  bid=$(dbi_of "$blocker"); cnum=$(num_of "$child")
  if [ -z "$bid" ] || [ -z "$cnum" ]; then echo "  SKIP $blocker -> $child (缺 id)"; EDGE_FAIL=1; return; fi
  if "$GH" api --method POST "repos/$REPO/issues/$cnum/dependencies/blocked_by" -F issue_id="$bid" >/dev/null 2>&1; then
    echo "  ok   $blocker (#$bid) blocks $child (#$cnum)"
  else
    echo "  FAIL $blocker -> $child"; EDGE_FAIL=1
  fi
}
wire R1 D1
wire R1 D4
wire R1 D5
wire R1 D6
wire R2 D2
wire R3 D3
wire D3 T1

echo "### summary"
echo "EDGE_FAIL=$EDGE_FAIL"
cat "$OUT"
