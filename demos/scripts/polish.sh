#!/usr/bin/env zsh
# ============================================================================
#  polish.sh — title card -> sped-up body -> end card.  (ffmpeg, no drawtext.)
#  Title/end cards are PNGs rendered by make-cards.mjs (headless Chrome), so we
#  get real brand fonts without an ffmpeg libfreetype build.
#
#  Usage:  ./demos/scripts/polish.sh <in.mp4> <out.mp4> <speed> <title.png> <end.png>
# ============================================================================
set -e
IN="$1"; OUT="$2"; SPEED="${3:-3}"; TITLE_PNG="$4"; END_PNG="$5"
W=1400; H=860; FPS=50
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

mkcard() { # png -> short video segment with gentle fades
  ffmpeg -y -loglevel error -loop 1 -i "$1" -t 2.6 -r $FPS \
    -vf "scale=$W:$H,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=2.2:d=0.4" \
    -c:v libx264 -pix_fmt yuv420p "$2"
}
mkcard "$TITLE_PNG" "$TMP/title.mp4"
mkcard "$END_PNG"   "$TMP/end.mp4"

# sped-up body
ffmpeg -y -loglevel error -i "$IN" -filter:v "setpts=PTS/${SPEED}" -an -c:v libx264 -pix_fmt yuv420p "$TMP/body.mp4"

# concat (normalize), gentle fade on the body tail
BDUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/body.mp4")
BF=$(printf '%.2f' "$(echo "$BDUR - 0.5" | bc -l)")
ffmpeg -y -loglevel error -i "$TMP/title.mp4" -i "$TMP/body.mp4" -i "$TMP/end.mp4" \
  -filter_complex "[0:v]fps=$FPS,setsar=1[a];[1:v]fps=$FPS,setsar=1,fade=t=out:st=${BF}:d=0.5[b];[2:v]fps=$FPS,setsar=1[c];[a][b][c]concat=n=3:v=1[o]" \
  -map "[o]" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT"
echo "  done: $OUT ($(ls -lh "$OUT" | awk '{print $5}'))"
