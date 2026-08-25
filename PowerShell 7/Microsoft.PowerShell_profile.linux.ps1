$fastfetch = Get-Command fastfetch -ErrorAction SilentlyContinue
if ($fastfetch)
{
	& $fastfetch.Source
}

$env:PATH = "$HOME/.dotnet:$env:PATH"

$ohMyPoshConfig = Join-Path $HOME 'Posh/mjp-mytheme.omp.json'

if ((Get-Command oh-my-posh -ErrorAction SilentlyContinue) -and (Test-Path $ohMyPoshConfig))
{
	oh-my-posh init pwsh --config $ohMyPoshConfig | Invoke-Expression
}
