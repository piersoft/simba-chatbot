#!/bin/bash
# SIMBA — Campionamento risorse Docker durante load test
# Lancia questo in una finestra PARALLELA a tests/load-test.mjs.
# Registra CPU%, MEM% di ollama e ckan-chat-backend ogni secondo.
#
# Uso:
#   bash tests/resource-sampler.sh
#   DURATION=300 bash tests/resource-sampler.sh
#
# Output: load-test-stats.csv (colonne: timestamp_ms, container, cpu_pct, mem_pct, mem_usage)

DURATION=${DURATION:-300}
OUTPUT="load-test-stats.csv"
CONTAINERS="ollama ckan-chat-backend validatore-mcp rdf-mcp"

echo "timestamp_ms,container,cpu_pct,mem_pct,mem_usage" > "$OUTPUT"
echo "📊 Campionamento risorse per ${DURATION}s su: $CONTAINERS"
echo "   Output: $OUTPUT"
echo "   Ctrl+C per fermare prima"
echo ""

end_at=$(($(date +%s) + DURATION))

while [ $(date +%s) -lt $end_at ]; do
  ts=$(date +%s%3N)
  # Singola chiamata per tutti i container (più efficiente)
  docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemPerc}},{{.MemUsage}}" $CONTAINERS 2>/dev/null | \
    while IFS=',' read -r name cpu mem_pct mem_use; do
      # Pulizia: rimuovi % e caratteri di formatting
      cpu_clean="${cpu%\%}"
      mem_pct_clean="${mem_pct%\%}"
      mem_use_clean=$(echo "$mem_use" | tr -d ',' | awk '{print $1}')
      echo "${ts},${name},${cpu_clean},${mem_pct_clean},${mem_use_clean}" >> "$OUTPUT"
    done
  sleep 1
done

echo ""
echo "✓ Campionamento completato. Righe raccolte: $(wc -l < "$OUTPUT")"
echo ""
echo "Picchi rilevati:"
for c in $CONTAINERS; do
  peak_cpu=$(awk -F',' -v name="$c" '$2==name {print $3}' "$OUTPUT" | sort -g | tail -1)
  peak_mem=$(awk -F',' -v name="$c" '$2==name {print $4}' "$OUTPUT" | sort -g | tail -1)
  echo "  $c:  CPU max=${peak_cpu}%  MEM max=${peak_mem}%"
done
