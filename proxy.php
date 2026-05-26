<?php
/**
 * TUM Balancer Production Proxy
 * Bypasses CORS and handles transport API requests on hosted environments.
 */

// Prevent any accidental output before headers
ob_start();

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');

// Handle settings persistence
if (isset($_GET['action'])) {
    $action = $_GET['action'];
    $settingsFile = 'settings.json';

    if ($action === 'save_settings') {
        $data = file_get_contents('php://input');
        if ($data) {
            if (file_put_contents($settingsFile, $data)) {
                ob_end_clean();
                header('Content-Type: application/json');
                echo json_encode(["success" => true]);
                exit;
            }
        }
        ob_end_clean();
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(["error" => "Failed to save settings"]);
        exit;
    }

    if ($action === 'load_settings') {
        ob_end_clean();
        header('Content-Type: application/json');
        if (file_exists($settingsFile)) {
            readfile($settingsFile);
        } else {
            echo json_encode([]);
        }
        exit;
    }
}

if (!isset($_GET['url'])) {
    ob_end_clean();
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(["error" => "url or action parameter is required"]);
    exit;
}

$url = $_GET['url'];

// Handle special transport URLs (MVG API)
if (strpos($url, '/departures') !== false && strpos($url, 'mvg.de') === false) {
    $station = 'de:09178:3239';
    if (preg_match('/station=([^&]+)/', $url, $m)) $station = $m[1];
    $url = "https://www.mvg.de/api/bgw-pt/v3/departures?globalId=$station&limit=30&offsetInMinutes=0&transportTypes=BAHN,SBAHN,UBAHN,TRAM,BUS,REGIONAL_BUS,SCHIFF";
} else if (strpos($url, '/nearby') !== false && strpos($url, 'mvg.de') === false) {
    if (preg_match('/latitude=([^&]+)&longitude=([^&]+)/', $url, $m)) {
        $url = "https://www.mvg.de/api/bgw-pt/v3/locations/nearby?latitude={$m[1]}&longitude={$m[2]}";
    }
} else if (strpos($url, '/trips') !== false && strpos($url, 'mvg.de') === false) {
    if (preg_match('/origin=([^&]+)&dest=([^&]+)/', $url, $m)) {
        $url = "https://www.mvg.de/api/bgw-pt/v3/trips?originId={$m[1]}&destId={$m[2]}";
    }
}

// Ensure we have a valid absolute URL now
if (!preg_match('/^https?:\/\//i', $url)) {
    ob_end_clean();
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(["error" => "Invalid URL protocol"]);
    exit;
}

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
if (!ini_get('open_basedir')) curl_setopt($ch, CURLOPT_FOLLOWLOCATION, 1);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 30);
curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
$curlError = curl_error($ch);
curl_close($ch);

// Clean any accidental output (like warnings or injected scripts) before sending the payload
ob_end_clean();

if ($curlError) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(["error" => "Proxy Error: " . $curlError]);
} else if ($httpCode >= 400) {
    http_response_code($httpCode);
    header('Content-Type: application/json');
    echo json_encode(["error" => "Remote Server Error: HTTP $httpCode"]);
} else {
    if ($contentType) header("Content-Type: $contentType");
    echo $response;
}
exit;
