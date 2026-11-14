import 'package:flutter/material.dart';

/// A lightweight, in-app bottle-tapping game shown only while a generation
/// request is running. It does not own or cancel the request.
class BottleShootingGameOverlay extends StatefulWidget {
  const BottleShootingGameOverlay({
    super.key,
    required this.statusText,
  });

  final String statusText;

  @override
  State<BottleShootingGameOverlay> createState() => _BottleShootingGameOverlayState();
}

class _BottleShootingGameOverlayState extends State<BottleShootingGameOverlay> {
  static const int _targetCount = 8;
  final Set<int> _broken = <int>{};
  int _score = 0;

  void _shoot(int index) {
    if (_broken.contains(index)) return;
    setState(() {
      _broken.add(index);
      _score += 10;
    });
    if (_broken.length == _targetCount) {
      Future<void>.delayed(const Duration(milliseconds: 450), () {
        if (!mounted) return;
        setState(() => _broken.clear());
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xED101712),
      child: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 28, 22, 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text("FACHS ARCADE", style: TextStyle(
                    color: Color(0xFF9BE6B4),
                    fontSize: 11,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 3,
                  )),
                  const SizedBox(height: 12),
                  const Text("Bottle pop!", style: TextStyle(
                    color: Colors.white,
                    fontSize: 32,
                    fontWeight: FontWeight.w900,
                  )),
                  const SizedBox(height: 8),
                  Text(widget.statusText, textAlign: TextAlign.center, style: const TextStyle(
                    color: Color(0xFFD5E2D8),
                    fontSize: 14,
                  )),
                  const SizedBox(height: 18),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
                    decoration: BoxDecoration(
                      color: const Color(0xFF26382C),
                      borderRadius: BorderRadius.circular(30),
                      border: Border.all(color: const Color(0xFF496B52)),
                    ),
                    child: Text("SCORE  $_score", style: const TextStyle(
                      color: Color(0xFFB7F2C6),
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.2,
                    )),
                  ),
                  const SizedBox(height: 26),
                  const Text("TAP THE BOTTLES TO POP THEM", style: TextStyle(
                    color: Color(0xFF9BAAA0),
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.4,
                  )),
                  const SizedBox(height: 18),
                  Wrap(
                    alignment: WrapAlignment.center,
                    spacing: 12,
                    runSpacing: 14,
                    children: List<Widget>.generate(_targetCount, (index) {
                      final popped = _broken.contains(index);
                      return Semantics(
                        button: true,
                        label: popped ? "Bottle popped" : "Pop bottle",
                        child: GestureDetector(
                          onTap: () => _shoot(index),
                          child: AnimatedContainer(
                            duration: const Duration(milliseconds: 160),
                            width: 68,
                            height: 88,
                            decoration: BoxDecoration(
                              color: popped ? const Color(0xFF27332B) : const Color(0xFF304C39),
                              borderRadius: BorderRadius.circular(16),
                              border: Border.all(
                                color: popped ? const Color(0xFF3E5545) : const Color(0xFF8BC99A),
                                width: 1.5,
                              ),
                            ),
                            child: Center(
                              child: AnimatedScale(
                                scale: popped ? 0.55 : 1,
                                duration: const Duration(milliseconds: 160),
                                child: Text(popped ? "✨" : "🍾", style: TextStyle(
                                  fontSize: popped ? 25 : 38,
                                )),
                              ),
                            ),
                          ),
                        ),
                      );
                    }),
                  ),
                  const SizedBox(height: 22),
                  const Text(
                    "Your workout or meal plan is being prepared in the background.",
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Color(0xFF9BAAA0), fontSize: 11, height: 1.5),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
