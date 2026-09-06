import 'package:flutter/material.dart';

class AppColors {
  static const bg = Color(0xFFF4F2EC);
  static const card = Color(0xFFFFFFFF);
  static const ink = Color(0xFF14161A);
  static const muted = Color(0xFF8A8F98);
  static const border = Color(0xFFE9E6DD);
  static const mint = Color(0xFF86E3C4);
  static const mintStrong = Color(0xFF5FD3A8);
  static const danger = Color(0xFFE05A4E);
}

ThemeData buildAppTheme() {
  return ThemeData(
    useMaterial3: true,
    scaffoldBackgroundColor: AppColors.bg,
    fontFamily: 'Roboto',
    colorScheme: ColorScheme.fromSeed(
      seedColor: AppColors.mint,
      primary: AppColors.ink,
      secondary: AppColors.mint,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.bg,
      foregroundColor: AppColors.ink,
      elevation: 0,
      centerTitle: false,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.card,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.border),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: AppColors.ink,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        textStyle: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
      ),
    ),
    textTheme: const TextTheme(
      headlineMedium: TextStyle(fontWeight: FontWeight.w800, fontSize: 26, letterSpacing: -0.3, color: AppColors.ink),
      bodyMedium: TextStyle(color: AppColors.muted, fontSize: 14),
    ),
  );
}

// Reusable button variants matching styles.css's .btn-mint / .btn-outline
class MintButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool loading;
  const MintButton({super.key, required this.label, this.onPressed, this.loading = false});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: ElevatedButton(
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.mint,
          foregroundColor: AppColors.ink,
          padding: const EdgeInsets.symmetric(vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        ),
        onPressed: loading ? null : onPressed,
        child: loading
            ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(strokeWidth: 2))
            : Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
    );
  }
}

class OutlineButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  const OutlineButton({super.key, required this.label, this.onPressed});

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.ink,
          backgroundColor: Colors.white,
          side: const BorderSide(color: AppColors.border),
          padding: const EdgeInsets.symmetric(vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
        ),
        onPressed: onPressed,
        child: Text(label, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
    );
  }
}

class AppCard extends StatelessWidget {
  final Widget child;
  const AppCard({super.key, required this.child});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.card,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: AppColors.border),
      ),
      child: child,
    );
  }
}

class InfoBanner extends StatelessWidget {
  final String message;
  final Color bg;
  final Color fg;
  const InfoBanner({super.key, required this.message, required this.bg, required this.fg});

  factory InfoBanner.error(String m) => InfoBanner(message: m, bg: const Color(0xFFFDE7E4), fg: AppColors.danger);
  factory InfoBanner.info(String m) => InfoBanner(message: m, bg: const Color(0xFFEEF6FE), fg: const Color(0xFF2874C9));
  factory InfoBanner.success(String m) => InfoBanner(message: m, bg: const Color(0xFFE8F9F1), fg: const Color(0xFF1F9D6D));

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Text(message, style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: 12)),
    );
  }
}
