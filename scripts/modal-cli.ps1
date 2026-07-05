param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]] $ModalArgs
)

$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$modalConfigDir = Join-Path $HOME ".modal-cli"
$modalCliImage = "bonobo-plugin-video-modal-cli:1.4.2"
$modalCliDockerfile = Join-Path $PSScriptRoot "..\modal\Dockerfile.cli"

New-Item -ItemType Directory -Force -Path $modalConfigDir | Out-Null

$imageExists = $false
try {
	docker image inspect $modalCliImage *> $null
	$imageExists = $LASTEXITCODE -eq 0
} catch {
	$imageExists = $false
}

if (-not $imageExists) {
	docker build --pull -t $modalCliImage -f $modalCliDockerfile (Split-Path $modalCliDockerfile -Parent)
}

docker run `
	--rm `
	-v "${workspaceRoot}:/workspace" `
	-v "${modalConfigDir}:/modal-config" `
	-w /workspace `
	-e "MODAL_CONFIG_PATH=/modal-config/.modal.toml" `
	$modalCliImage `
	@ModalArgs
