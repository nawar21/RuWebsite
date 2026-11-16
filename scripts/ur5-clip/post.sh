#!/bin/sh
# Turns the clean Cycles frames into something that looks shot on a phone: sensor noise smeared by the
# phone's temporal noise reduction, auto-exposure breathing, a cool LED cast, lens vignette and colour
# fringing, highlight bloom, over-sharpening, and two rounds of lossy compression (camera, then upload).
# Usage: post.sh FRAMES_DIR AUDIO_WAV OUT_MP4 [first_frame count]   (needs ffmpeg with libx264)
set -e
FR=$1; WAV=$2; OUT=$3
START=${4:-1}; COUNT=${5:-100000}
TMP=$(mktemp -d)

ffmpeg -v error -y -framerate 30 -start_number "$START" -i "$FR/f_%04d.png" -frames:v "$COUNT" -filter_complex "
  [0]format=gbrp,split[base][hl];
  [hl]curves=all='0/0 0.72/0 1/1',gblur=sigma=14[glow];
  [base][glow]blend=all_mode=screen:all_opacity=0.45,format=yuv444p,
  noise=c0s=10:c0f=t+u:c1s=6:c1f=t+u:c2s=6:c2f=t+u,
  hqdn3d=1.4:1.2:5:5,
  eq=contrast=1.05:saturation=1.07:gamma=0.97:brightness='0.012*sin(2*PI*t*0.29)+0.005*sin(2*PI*t*1.7+1)':eval=frame,
  colorbalance=rs=-0.015:gs=0.010:bs=0.022:rh=0.012:bh=-0.012,
  vignette=angle=PI/5.2,
  rgbashift=rh=-1:bh=1,
  unsharp=5:5:0.75:3:3:0.0,
  format=yuv420p" \
  -c:v libx264 -preset veryfast -b:v 2000k -maxrate 2600k -bufsize 1600k -g 30 "$TMP/camera.mp4"

ffmpeg -v error -y -i "$TMP/camera.mp4" -i "$WAV" -map 0:v -map 1:a -shortest \
  -c:v libx264 -preset slow -crf 25 -profile:v high -pix_fmt yuv420p -g 60 \
  -c:a aac -b:a 96k -ac 1 -movflags +faststart "$OUT"
rm -rf "$TMP"
