#!/usr/bin/env bash
# Publish the source of the Arc testnet contract on the Arc explorer (Blockscout), so anyone can read it.
# Usage: ./verify-arc.sh     (address from deployments/5042002.json, source from the last Hardhat build)
# Run `npx hardhat compile` first if you changed the contract. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")"
EXPLORER=https://explorer.testnet.arc.io
INPUT=$(mktemp); trap 'rm -f "$INPUT"' EXIT
python3 - "$INPUT" <<'PY'
import json, sys, glob
for f in sorted(glob.glob('artifacts/build-info/*.json'), key=lambda p: -__import__('os').path.getmtime(p)):
    j = json.load(open(f))
    if 'Tap2Eth' in j['output']['contracts'].get('contracts/v2/Tap2Eth.sol', {}):
        json.dump(j['input'], open(sys.argv[1], 'w')); break
else:
    sys.exit('Tap2Eth is not compiled. Run: npx hardhat compile')
PY
ADDR=$(python3 -c "import json; print(json.load(open('deployments/5042002.json'))['tap2eth'])")
curl -sL --post301 --post302 -X POST "$EXPLORER/api/v2/smart-contracts/$ADDR/verification/via/standard-input" \
  -F compiler_version=v0.8.28+commit.7893614a -F "contract_name=contracts/v2/Tap2Eth.sol:Tap2Eth" \
  -F autodetect_constructor_args=true -F license_type=mit -F "files[0]=@$INPUT;type=application/json"
echo
echo "Give it ~30 seconds, then open $EXPLORER/address/$ADDR?tab=contract"
