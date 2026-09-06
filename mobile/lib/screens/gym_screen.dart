import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import '../api/api_client.dart';
import '../theme/app_theme.dart';

class GymScreen extends StatefulWidget {
  const GymScreen({super.key});
  @override
  State<GymScreen> createState() => _GymScreenState();
}

class _GymScreenState extends State<GymScreen> {
  bool _loading = true;
  Map<String, dynamic>? _status;
  List<dynamic> _history = [];
  String? _banner;
  bool _bannerIsError = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final status = await ApiClient.instance.get("/gym/today");
      final history = await ApiClient.instance.get("/gym/history");
      setState(() {
        _status = status;
        _history = history;
        _loading = false;
      });
    } catch (e) {
      setState(() => _loading = false);
    }
  }

  Future<void> _checkin(String method) async {
    try {
      await ApiClient.instance.post("/gym/checkin", {"method": method});
      await _load();
    } on ApiException catch (e) {
      setState(() {
        _banner = e.message; // e.g. "Already checked in today"
        _bannerIsError = true;
      });
    }
  }

  Future<void> _scanQr() async {
    final scanned = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const _QrScanScreen()),
    );
    if (scanned == true) {
      await _checkin("qr");
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    final checkedIn = _status?["checkedIn"] == true;
    final attendance = _status?["attendance"];

    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 24),
        children: [
          Text("Gym Check-in", style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 4),
          Text("One attendance entry per day.", style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: 14),
          if (_banner != null) _bannerIsError ? InfoBanner.error(_banner!) : InfoBanner.success(_banner!),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text("📇 Attendance", style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                checkedIn
                    ? InfoBanner.success("Checked in today (${attendance["method"]})")
                    : const Text("Not checked in yet today.", style: TextStyle(color: AppColors.muted)),
              ],
            ),
          ),
          Row(children: [
            Expanded(child: MintButton(label: "Scan QR", onPressed: checkedIn ? null : _scanQr)),
            const SizedBox(width: 10),
            Expanded(child: OutlineButton(label: "Mark manually", onPressed: checkedIn ? null : () => _checkin("manual"))),
          ]),
          const SizedBox(height: 14),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text("History (last 30)", style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                if (_history.isEmpty)
                  const Text("No attendance yet.", style: TextStyle(color: AppColors.muted))
                else
                  for (final h in _history)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(h["date"], style: const TextStyle(fontWeight: FontWeight.w600)),
                          Chip(label: Text(h["method"]), backgroundColor: AppColors.bg, side: const BorderSide(color: AppColors.border)),
                        ],
                      ),
                    ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _QrScanScreen extends StatefulWidget {
  const _QrScanScreen();
  @override
  State<_QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<_QrScanScreen> {
  bool _handled = false;

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    if (capture.barcodes.isNotEmpty) {
      _handled = true;
      Navigator.of(context).pop(true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("Scan gym QR code")),
      body: MobileScanner(onDetect: _onDetect),
    );
  }
}
