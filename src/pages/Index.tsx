import { useState, useEffect } from "react";
import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { DemoVideo } from "@/components/landing/DemoVideo";
import { WhyArivioo } from "@/components/landing/WhyArivioo";
import { ExampleResult } from "@/components/landing/ExampleResult";
import { Testimonials } from "@/components/landing/Testimonials";
import { Trust } from "@/components/landing/Trust";
import { FAQ } from "@/components/landing/FAQ";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { Footer } from "@/components/landing/Footer";
import { UnderConstructionModal } from "@/components/UnderConstructionModal";
import { supabase } from "@/integrations/supabase/client";

const Index = () => {
  const [accessGranted, setAccessGranted] = useState<boolean | null>(null);

  useEffect(() => {
    // Check server-side access grant
    const checkAccess = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        
        if (user) {
          // Check if user has a valid access grant in the database
          const { data: grant, error } = await supabase
            .from('access_grants')
            .select('granted_until')
            .eq('user_id', user.id)
            .maybeSingle();
          
          if (!error && grant && new Date(grant.granted_until) > new Date()) {
            setAccessGranted(true);
            return;
          }
        }
        
        setAccessGranted(false);
      } catch (error) {
        console.error('Error checking access:', error);
        setAccessGranted(false);
      }
    };

    checkAccess();
  }, []);

  const handleAccessGranted = () => {
    setAccessGranted(true);
  };

  // Show nothing while checking access to prevent flash
  if (accessGranted === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  // Show modal if access not granted
  if (!accessGranted) {
    return <UnderConstructionModal onAccessGranted={handleAccessGranted} />;
  }

  return (
    <div className="min-h-screen">
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <DemoVideo />
        <section id="why-arivioo">
          <WhyArivioo />
        </section>
        <ExampleResult />
        <Testimonials />
        <Trust />
        <FAQ />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
};

export default Index;
