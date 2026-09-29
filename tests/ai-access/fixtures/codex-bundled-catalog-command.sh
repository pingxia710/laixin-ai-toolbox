#!/bin/sh

if [ "$1" = 'debug' ] && [ "$2" = 'models' ] && [ "$3" = '--bundled' ]; then
  fifo="${BUNDLED_CATALOG_FIXTURE_PID}.fifo"
  mkfifo "$fifo" || exit 1
  exec 3<> "$fifo"
  rm "$fifo"
  trap '' TERM
  printf '%s' "$$" > "$BUNDLED_CATALOG_FIXTURE_PID"
  while :; do read -r line <&3; done
fi

exit 1
