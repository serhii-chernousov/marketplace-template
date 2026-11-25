# shellcheck shell=bash
# Sourced by the AWS evidence and demo scripts.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pulumi_aws() {
	bash "$ROOT/scripts/pulumi-aws.sh" "$@"
}

stack_region() {
	pulumi_aws "$1" config get aws:region
}

# Replaces the key instead of appending, so a rerun never leaves two values.
evidence_set() {
	local file="$1" key="$2" value="$3" tmp
	mkdir -p "$(dirname "$file")"
	touch "$file"
	tmp="$(mktemp)"
	grep -v "^$key=" "$file" >"$tmp" || true
	echo "$key=$value" >>"$tmp"
	mv "$tmp" "$file"
	echo "$key=$value"
}

minutes_between() {
	node -e 'const [a,b]=process.argv.slice(1).map(Date.parse);console.log(Math.max(1,Math.ceil((b-a)/60000)))' "$1" "$2"
}

seconds_between() {
	node -e 'const [a,b]=process.argv.slice(1).map(Date.parse);console.log(Math.round((b-a)/1000))' "$1" "$2"
}
