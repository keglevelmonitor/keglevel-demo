$msg = Read-Host "Description of commit"
if (-not $msg) {
    Write-Host "No description entered. Aborting." -ForegroundColor Red
    exit 1
}

Set-Location "C:\Users\colem\Desktop\pi_transfer_folder\IDE\KegLevel-Demo"

git add .
Write-Host ""
git status
Write-Host ""

$confirm = Read-Host "Proceed with commit and push? (y/n)"
if ($confirm -ne "y") {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 0
}

git commit -m "$msg"
git push origin main
