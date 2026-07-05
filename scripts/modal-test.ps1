param(
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]] $PytestArgs
)

$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$modalTestImage = "bonobo-plugin-video-modal-test:1.4.2"
$modalTestDockerfile = Join-Path $PSScriptRoot "..\modal\Dockerfile.test"

if ($PytestArgs.Count -eq 0) {
	$PytestArgs = @("modal")
}

$imageExists = $false
try {
	docker image inspect $modalTestImage *> $null
	$imageExists = $LASTEXITCODE -eq 0
} catch {
	$imageExists = $false
}

if (-not $imageExists) {
	docker build --pull -t $modalTestImage -f $modalTestDockerfile (Split-Path $modalTestDockerfile -Parent)
	if ($LASTEXITCODE -ne 0) {
		exit $LASTEXITCODE
	}
}

docker run `
	--rm `
	-v "${workspaceRoot}:/workspace" `
	-w /workspace `
	$modalTestImage `
	@PytestArgs

exit $LASTEXITCODE
