#!/bin/bash
SP=/tmp/claude-0/-home-claude/c8eb4696-ce79-544f-9af6-5afa8b7c6de4/scratchpad; OUT=/home/claude/excel_measurements/public/help/media; mkdir -p $SP/enc
declare -A POSTER=([01-projects]=62 [02-3d-tools]=22 [03-measure]=36 [04-ai]=30 [05-revisions-output]=34 [06-dimension-groups]=100 [07-schedule-isolate]=33)
for n in "${!POSTER[@]}"; do
  ffmpeg -v error -y -i $SP/media/$n.webm -vf scale=1280:720 -c:v libvpx-vp9 -crf 36 -b:v 0 -row-mt 1 -cpu-used 4 -an $SP/enc/$n.webm
  ffmpeg -v error -y -ss ${POSTER[$n]} -i $SP/media/$n.webm -vf scale=1280:720 -frames:v 1 -q:v 4 $SP/enc/$n.jpg
  echo $n $(du -k $SP/enc/$n.webm | cut -f1)KB
done
echo ENCDONE
