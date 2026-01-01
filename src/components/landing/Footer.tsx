import { Link } from "react-router-dom";
import { AriviooLogoStatic } from "@/components/AriviooLogo";

export function Footer() {
  return (
    <footer className="bg-foreground text-background py-12">
      <div className="container px-4">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Logo */}
          <AriviooLogoStatic size="md" variant="dark" />

          {/* Links */}
          <div className="flex items-center gap-6 text-sm text-background/70">
            <button
              onClick={() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })}
              className="hover:text-background transition-colors"
            >
              How It Works
            </button>
            <Link to="/auth" className="hover:text-background transition-colors">
              Log In
            </Link>
            <Link to="/auth?mode=signup" className="hover:text-background transition-colors">
              Sign Up
            </Link>
          </div>

          {/* Copyright */}
          <p className="text-sm text-background/50">
            © {new Date().getFullYear()} Arivioo. All rights reserved.
          </p>
        </div>

        <div className="mt-8 pt-8 border-t border-background/10 text-center">
          <p className="text-xs text-background/40">
            Arivioo is an independent service and is not affiliated with, endorsed by, or connected to Airbnb or any other vacation rental platform.
          </p>
        </div>
      </div>
    </footer>
  );
}
