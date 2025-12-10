import { useState } from "react";
import { Play, Pause, Search, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

const steps = [
  {
    time: "0:00",
    label: "Paste Link",
    description: "Copy any Airbnb listing URL",
    icon: Search,
  },
  {
    time: "0:05",
    label: "AI Searches",
    description: "We scan the web for matches",
    icon: Search,
  },
  {
    time: "0:35",
    label: "Compare",
    description: "See side-by-side pricing",
    icon: CheckCircle2,
  },
  {
    time: "0:40",
    label: "Book Direct",
    description: "One click to the best deal",
    icon: ExternalLink,
  },
];

export function DemoVideo() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  const handlePlay = () => {
    setIsPlaying(true);
    setCurrentStep(0);
    
    // Simulate video progress through steps
    const stepDurations = [5000, 30000, 5000, 5000];
    let stepIndex = 0;
    
    const advanceStep = () => {
      if (stepIndex < steps.length - 1) {
        stepIndex++;
        setCurrentStep(stepIndex);
        setTimeout(advanceStep, stepDurations[stepIndex]);
      } else {
        setIsPlaying(false);
      }
    };
    
    setTimeout(advanceStep, stepDurations[0]);
  };

  return (
    <section id="demo" className="py-20 md:py-28 bg-background">
      <div className="container px-4">
        <div className="text-center mb-12 md:mb-16">
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-foreground mb-4">
            See It in <span className="text-gradient">Action</span>
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Watch how easy it is to find savings on your next vacation rental in under a minute.
          </p>
        </div>

        <div className="max-w-4xl mx-auto">
          {/* Video Container */}
          <div className="relative rounded-2xl overflow-hidden shadow-large border border-border bg-card">
            {/* Simulated Video Player */}
            <div className="aspect-video bg-gradient-to-br from-secondary to-muted relative overflow-hidden">
              {/* Animated Demo Content */}
              <div className="absolute inset-0 flex items-center justify-center">
                {!isPlaying ? (
                  <Button
                    size="lg"
                    onClick={handlePlay}
                    className="w-20 h-20 rounded-full bg-gradient-primary hover:opacity-90 shadow-large"
                  >
                    <Play className="w-8 h-8 ml-1" fill="white" />
                  </Button>
                ) : (
                  <div className="w-full h-full p-8 flex flex-col items-center justify-center">
                    {/* Animated Search Demo */}
                    <div className="w-full max-w-lg">
                      {currentStep === 0 && (
                        <div className="animate-fade-in">
                          <div className="bg-card rounded-xl p-4 shadow-medium border border-border mb-4">
                            <div className="flex items-center gap-3">
                              <div className="flex-1 h-12 bg-muted rounded-lg flex items-center px-4 overflow-hidden">
                                <span className="text-muted-foreground text-sm truncate animate-pulse">
                                  https://airbnb.com/rooms/luxury-beach-villa...
                                </span>
                              </div>
                              <Button size="sm" className="bg-gradient-primary h-12 px-6">
                                Search
                              </Button>
                            </div>
                          </div>
                          <p className="text-center text-foreground font-medium">Pasting your Airbnb link...</p>
                        </div>
                      )}
                      
                      {currentStep === 1 && (
                        <div className="animate-fade-in text-center">
                          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
                            <Search className="w-8 h-8 text-primary animate-pulse" />
                          </div>
                          <p className="text-foreground font-medium mb-2">AI is searching the web...</p>
                          <p className="text-muted-foreground text-sm">Checking Vrbo, Booking.com, direct sites...</p>
                          <div className="mt-4 flex justify-center gap-2">
                            {[0, 1, 2].map((i) => (
                              <div
                                key={i}
                                className="w-3 h-3 rounded-full bg-primary animate-bounce"
                                style={{ animationDelay: `${i * 0.15}s` }}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {currentStep === 2 && (
                        <div className="animate-fade-in">
                          <div className="grid grid-cols-2 gap-4">
                            <div className="bg-card rounded-xl p-4 border border-border">
                              <div className="text-xs text-muted-foreground mb-2">Airbnb</div>
                              <div className="text-xl font-bold text-foreground">$245/night</div>
                            </div>
                            <div className="bg-success/10 rounded-xl p-4 border-2 border-success">
                              <div className="text-xs text-success mb-2">Direct Booking</div>
                              <div className="text-xl font-bold text-success">$189/night</div>
                            </div>
                          </div>
                          <p className="text-center text-success font-semibold mt-4">Save $56/night found!</p>
                        </div>
                      )}
                      
                      {currentStep === 3 && (
                        <div className="animate-fade-in text-center">
                          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-success/20 flex items-center justify-center">
                            <CheckCircle2 className="w-8 h-8 text-success" />
                          </div>
                          <p className="text-foreground font-medium mb-2">Ready to book!</p>
                          <Button className="bg-gradient-primary">
                            Book Direct & Save
                            <ExternalLink className="w-4 h-4 ml-2" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Play/Pause overlay for when playing */}
              {isPlaying && (
                <button
                  onClick={() => setIsPlaying(false)}
                  className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center transition-colors"
                >
                  <Pause className="w-5 h-5 text-white" fill="white" />
                </button>
              )}
            </div>

            {/* Progress Steps */}
            <div className="p-4 md:p-6 bg-card border-t border-border">
              <div className="flex justify-between items-center gap-2 md:gap-4">
                {steps.map((step, index) => {
                  const Icon = step.icon;
                  const isActive = isPlaying && currentStep >= index;
                  const isCurrent = isPlaying && currentStep === index;
                  
                  return (
                    <div
                      key={index}
                      className={`flex-1 text-center transition-all duration-300 ${
                        isActive ? "opacity-100" : "opacity-50"
                      }`}
                    >
                      <div
                        className={`w-10 h-10 md:w-12 md:h-12 mx-auto mb-2 rounded-full flex items-center justify-center transition-all duration-300 ${
                          isCurrent
                            ? "bg-gradient-primary text-white scale-110"
                            : isActive
                            ? "bg-success/20 text-success"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <Icon className="w-5 h-5 md:w-6 md:h-6" />
                      </div>
                      <p className={`text-xs md:text-sm font-medium ${isActive ? "text-foreground" : "text-muted-foreground"}`}>
                        {step.label}
                      </p>
                      <p className="text-xs text-muted-foreground hidden md:block">
                        {step.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Caption */}
          <p className="text-center text-muted-foreground text-sm mt-4">
            Average search time: 30-45 seconds
          </p>
        </div>
      </div>
    </section>
  );
}
